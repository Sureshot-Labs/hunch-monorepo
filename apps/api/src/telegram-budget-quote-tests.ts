import assert from "node:assert/strict";
import {
  calculatePolymarketQuote,
  calculatePolymarketSignedBuyRequiredSpendRaw,
  quotePolymarketMarketBuyWithinBudget,
  PolymarketQuoteError,
  type PolymarketQuoteContext,
} from "./services/polymarket-quote.js";

function context(
  price: number,
  tick: number,
  rate: number,
  size = 1_000_000,
): PolymarketQuoteContext {
  return {
    orderbook: {
      bids: [{ price, size }],
      asks: [{ price, size }],
      tickSize: tick,
      minOrderSize: 5,
      negRisk: false,
    },
    marketInfo: null,
    platformFeeCurve: {
      rate,
      exponent: 1,
      takerOnly: true,
      makerBaseFeeBps: 0,
      takerBaseFeeBps: 0,
    },
    feePolicySnapshot: {
      venue: "polymarket",
      collectionMode: "none",
      builderCode: `0x${"0".repeat(64)}`,
      builderTakerFeeBps: 0,
      builderMakerFeeBps: 0,
      builderRateSource: "none",
      builderEnabled: false,
      legacyFeeBps: 0,
      feePolicyId: null,
      capturedAt: new Date(0).toISOString(),
    },
  };
}

let count = 0;
for (const tick of [0.001, 0.01]) {
  for (const price of [tick, 0.1, 0.33, 0.5, 0.53, 1 - tick]) {
    for (const rate of [0, 0.05, 0.07]) {
      for (const budget of [1, 5, 15]) {
        const quote = quotePolymarketMarketBuyWithinBudget({
          context: context(price, tick, rate),
          tokenId: "token",
          budgetRaw: BigInt(budget * 1e6),
          slippageBps: 100,
        });
        assert.ok(quote.totalRequiredUsdcRaw);
        assert.ok(BigInt(quote.totalRequiredUsdcRaw) <= BigInt(budget * 1e6));
        const signedSpend = calculatePolymarketSignedBuyRequiredSpendRaw({
          context: context(price, tick, rate),
          orderType: "FOK",
          makerAmountRaw: BigInt(quote.makerAmount),
          takerAmountRaw: BigInt(quote.takerAmount),
        });
        assert.ok(
          signedSpend != null &&
            signedSpend <= BigInt(quote.totalRequiredUsdcRaw),
        );
        assert.ok(quote.price <= price * 1.01 + 1e-12);
        assert.ok(
          Number(quote.makerAmount) / Number(quote.takerAmount) <=
            price * 1.01 + 1e-12,
        );
        const sell = calculatePolymarketQuote({
          context: context(price, tick, rate),
          tokenId: "token",
          side: "SELL",
          orderType: "FOK",
          amountType: "shares",
          amountSharesInput: 100,
          slippageBps: 100,
          strictSlippage: true,
        });
        assert.ok(sell.price >= price * 0.99 - 1e-12);
        assert.ok(
          Number(sell.takerAmount) / Number(sell.makerAmount) >=
            price * 0.99 - 1e-12,
        );
        count++;
      }
    }
  }
}
assert.throws(
  () =>
    quotePolymarketMarketBuyWithinBudget({
      context: context(0.5, 0.01, 0, 0.1),
      tokenId: "token",
      budgetRaw: 5_000_000n,
      slippageBps: 100,
    }),
  (error: unknown) =>
    error instanceof PolymarketQuoteError && error.reason === "no_liquidity",
);
const legacy = calculatePolymarketQuote({
  context: context(0.5, 0.01, 0),
  tokenId: "token",
  side: "BUY",
  orderType: "FOK",
  amountType: "usd",
  amountUsdInput: 1,
  slippageBps: 100,
});
assert.equal(legacy.price, 0.51);
assert.throws(
  () =>
    quotePolymarketMarketBuyWithinBudget({
      context: context(0.5, 0.001, 0, 1.99),
      tokenId: "token",
      budgetRaw: 1_000_000n,
      slippageBps: 100,
    }),
  (error: unknown) =>
    error instanceof PolymarketQuoteError && error.reason === "no_liquidity",
  "FOK requires depth for the entire USD nominal, not just minimum limit-price shares",
);
const funded = quotePolymarketMarketBuyWithinBudget({
  context: context(0.5, 0.01, 0.05),
  tokenId: "token",
  budgetRaw: 1_000_000n,
  executableFundsRaw: 2_000_000n,
  minimumNominalRaw: 1_000_000n,
  slippageBps: 100,
});
assert.equal(funded.makerAmount, "1000000");
assert.ok(funded.totalRequiredUsdcRaw);
assert.ok(BigInt(funded.totalRequiredUsdcRaw) > 1_000_000n);
assert.throws(
  () =>
    quotePolymarketMarketBuyWithinBudget({
      context: context(0.5, 0.01, 0.05),
      tokenId: "token",
      budgetRaw: 1_000_000n,
      executableFundsRaw: 1_000_000n,
      minimumNominalRaw: 1_000_000n,
      slippageBps: 100,
    }),
  (error: unknown) =>
    error instanceof PolymarketQuoteError &&
    error.reason === "amount_too_small",
);
const adjusted = quotePolymarketMarketBuyWithinBudget({
  context: context(0.5, 0.01, 0.05),
  tokenId: "token",
  budgetRaw: 5_000_000n,
  executableFundsRaw: 5_000_000n,
  minimumNominalRaw: 1_000_000n,
  slippageBps: 100,
});
assert.ok(BigInt(adjusted.makerAmount) < 5_000_000n);
assert.ok(adjusted.totalRequiredUsdcRaw);
assert.ok(BigInt(adjusted.totalRequiredUsdcRaw) <= 5_000_000n);
console.log(
  `Telegram budget/strict rounding: ${count} combinations passed; thin book and legacy passed.`,
);
