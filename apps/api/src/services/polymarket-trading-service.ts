import type { Pool } from "@hunch/infra";

import {
  calculatePolymarketQuote,
  findMaxPolymarketMarketBuyUsdDetailed,
  loadPolymarketQuoteContext,
  type PolymarketAmountType,
  type PolymarketClobOrderType,
  type PolymarketQuoteResult,
  type PolymarketSide,
} from "./polymarket-quote.js";

type PolymarketQuoteWarnLogger = (args: {
  error: unknown;
  tokenId: string;
  conditionId: string | null | undefined;
}) => void;

export async function quotePolymarketOrder(
  pool: Pool,
  input: {
    tokenId: string;
    side: PolymarketSide;
    orderType: PolymarketClobOrderType;
    amountType: PolymarketAmountType;
    amountUsdInput?: number | null;
    amountSharesInput?: number | null;
    limitPrice?: number | null;
    slippageBps?: number | null;
    logWarn?: PolymarketQuoteWarnLogger;
  },
): Promise<PolymarketQuoteResult> {
  const context = await loadPolymarketQuoteContext(pool, {
    tokenId: input.tokenId,
    logWarn: input.logWarn,
  });
  return calculatePolymarketQuote({
    tokenId: input.tokenId,
    side: input.side,
    orderType: input.orderType,
    amountType: input.amountType,
    amountUsdInput: input.amountUsdInput,
    amountSharesInput: input.amountSharesInput,
    limitPrice: input.limitPrice,
    slippageBps: input.slippageBps,
    context,
  });
}

export async function findMaxPolymarketMarketBuyUsdForFunds(
  pool: Pool,
  input: {
    tokenId: string;
    executableFundsRaw: bigint;
    slippageBps?: number | null;
    logWarn?: PolymarketQuoteWarnLogger;
  },
) {
  const context = await loadPolymarketQuoteContext(pool, {
    tokenId: input.tokenId,
    logWarn: input.logWarn,
  });
  return findMaxPolymarketMarketBuyUsdDetailed({
    context,
    tokenId: input.tokenId,
    executableFundsRaw: input.executableFundsRaw,
    slippageBps: input.slippageBps,
    requireOrderbookDepth: true,
  });
}
