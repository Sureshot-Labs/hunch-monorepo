#!/usr/bin/env tsx

import assert from "node:assert/strict";
import {
  calculatePolymarketQuote,
  findMaxPolymarketMarketBuyUsd,
  PolymarketQuoteError,
  type PolymarketQuoteContext,
} from "./services/polymarket-quote.js";
import {
  computePolymarketClobOpenOrderLocks,
  computePolymarketExecutableFunds,
  evaluatePolymarketBuyApprovalReadiness,
  POLYMARKET_BUY_APPROVAL_THRESHOLD,
  polymarketAllowanceSatisfiesBuyApproval,
} from "./services/polymarket-max-spend.js";
import type { PolymarketFeePolicySnapshot } from "./services/polymarket-builder-fees.js";
import {
  buildPolymarketFundingPlan,
  decodePolymarketFundingCalldata,
  PolymarketFundingPlanError,
} from "./services/polymarket-funding-router.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const SIGNER = "0x0000000000000000000000000000000000000011";
const DEPOSIT = "0x0000000000000000000000000000000000000022";
const ROUTER = "0x0000000000000000000000000000000000000033";

const noFeePolicy: PolymarketFeePolicySnapshot = {
  venue: "polymarket",
  collectionMode: "none",
  builderCode: ZERO_BYTES32,
  builderTakerFeeBps: 0,
  builderMakerFeeBps: 0,
  builderRateSource: "none",
  builderEnabled: false,
  legacyFeeBps: 0,
  feePolicyId: null,
  capturedAt: new Date(0).toISOString(),
};

const baseMarketInfo: NonNullable<PolymarketQuoteContext["marketInfo"]> = {
  polymarket_id: "pm-test",
  unified_market_id: "market-test",
  condition_id: "condition-test",
  clob_token_ids: JSON.stringify(["token-yes", "token-no"]),
  neg_risk: false,
  order_price_min_tick_size: "0.01",
  order_min_size: "5",
  accepting_orders: true,
  taker_fee_bps: "500",
  maker_fee_bps: "0",
};

function builderFeePolicy(
  builderTakerFeeBps: number,
): PolymarketFeePolicySnapshot {
  return {
    ...noFeePolicy,
    collectionMode: "builder",
    builderCode:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    builderTakerFeeBps,
    builderRateSource: "fallback",
    builderEnabled: true,
  };
}

function quoteContext(
  overrides: Partial<PolymarketQuoteContext> = {},
): PolymarketQuoteContext {
  return {
    orderbook: {
      bids: [{ price: 0.49, size: 10_000 }],
      asks: [{ price: 0.5, size: 10_000 }],
      tickSize: 0.01,
      minOrderSize: 5,
      negRisk: false,
    },
    marketInfo: baseMarketInfo,
    feePolicySnapshot: noFeePolicy,
    platformFeeCurve: null,
    ...overrides,
  };
}

function noFeeNoMinContext(): PolymarketQuoteContext {
  return quoteContext({
    orderbook: {
      bids: [{ price: 0.49, size: 10_000 }],
      asks: [{ price: 0.5, size: 10_000 }],
      tickSize: 0.01,
      minOrderSize: 0,
      negRisk: false,
    },
    marketInfo: {
      ...baseMarketInfo,
      order_min_size: "0",
      taker_fee_bps: "0",
      maker_fee_bps: "0",
    },
  });
}

const tests: TestCase[] = [
  {
    name: "max spend preserves exact cent raw amounts without float drift",
    run: () => {
      const context = noFeeNoMinContext();
      for (const cents of [29n, 57n, 116n]) {
        const expectedRaw = cents * 10_000n;
        const max = findMaxPolymarketMarketBuyUsd({
          context,
          tokenId: "token-yes",
          executableFundsRaw: expectedRaw,
        });

        assert.ok(max);
        assert.equal(max.maxAmountUsdRaw, expectedRaw.toString());
        assert.equal(max.quote.makerAmount, expectedRaw.toString());
        assert.equal(max.quote.totalRequiredUsdcRaw, expectedRaw.toString());
        assert.equal(max.quote.amountUsdUsed, Number(expectedRaw) / 1_000_000);
      }
    },
  },
  {
    name: "max spend is lower than visible funds when quote fees exceed funds",
    run: () => {
      const context = quoteContext();
      const executableFundsRaw = 848_860_000n;
      const fullQuote = calculatePolymarketQuote({
        tokenId: "token-yes",
        side: "BUY",
        orderType: "FOK",
        amountType: "usd",
        amountUsdInput: 848.86,
        context,
      });
      assert.ok(
        BigInt(fullQuote.totalRequiredUsdcRaw ?? "0") > executableFundsRaw,
      );

      const max = findMaxPolymarketMarketBuyUsd({
        context,
        tokenId: "token-yes",
        executableFundsRaw,
      });
      assert.ok(max);
      assert.ok(Number(max.maxAmountUsdRaw) < Number(executableFundsRaw));
      assert.ok(
        BigInt(max.quote.totalRequiredUsdcRaw ?? "0") <= executableFundsRaw,
      );
    },
  },
  {
    name: "deposit wallet executable funds include funder pUSD plus signer pUSD and USDC.e",
    run: () => {
      const funds = computePolymarketExecutableFunds({
        signer: "0x1111111111111111111111111111111111111111",
        funder: "0x2222222222222222222222222222222222222222",
        funderExecutionKind: "deposit_wallet",
        funderPusdRaw: 6_150_000n,
        signerPusdRaw: 800_000_000n,
        signerUsdceRaw: 42_710_000n,
      });

      assert.equal(funds.usesSignerTopUp, true);
      assert.equal(funds.executableFundsRaw, 848_860_000n);
      assert.equal(funds.signerLockedRaw, 0n);
      assert.equal(funds.signerPusdTopUpRaw, 800_000_000n);
      assert.equal(funds.signerUsdceTopUpRaw, 42_710_000n);
    },
  },
  {
    name: "safe funder excludes signer top-up funds",
    run: () => {
      const funds = computePolymarketExecutableFunds({
        signer: "0x1111111111111111111111111111111111111111",
        funder: "0x2222222222222222222222222222222222222222",
        funderExecutionKind: "safe",
        funderPusdRaw: 6_150_000n,
        signerPusdRaw: 800_000_000n,
        signerUsdceRaw: 42_710_000n,
      });

      assert.equal(funds.usesSignerTopUp, false);
      assert.equal(funds.executableFundsRaw, 6_150_000n);
      assert.equal(funds.signerLockedRaw, 0n);
      assert.equal(funds.signerPusdTopUpRaw, 0n);
      assert.equal(funds.signerUsdceTopUpRaw, 0n);
    },
  },
  {
    name: "open-order locked collateral reduces executable funder balance",
    run: () => {
      const funds = computePolymarketExecutableFunds({
        signer: "0x1111111111111111111111111111111111111111",
        funder: "0x2222222222222222222222222222222222222222",
        funderExecutionKind: "safe",
        funderPusdRaw: 100_000_000n,
        funderLockedRaw: 40_000_000n,
        signerPusdRaw: 900_000_000n,
        signerUsdceRaw: 900_000_000n,
      });

      assert.equal(funds.funderPusdAvailableRaw, 60_000_000n);
      assert.equal(funds.executableFundsRaw, 60_000_000n);
    },
  },
  {
    name: "signer pUSD top-up is reduced by signer open-order locks",
    run: () => {
      const funds = computePolymarketExecutableFunds({
        signer: "0x1111111111111111111111111111111111111111",
        funder: "0x2222222222222222222222222222222222222222",
        funderExecutionKind: "deposit_wallet",
        funderPusdRaw: 6_150_000n,
        funderLockedRaw: 1_000_000n,
        signerPusdRaw: 800_000_000n,
        signerLockedRaw: 100_000_000n,
        signerUsdceRaw: 42_710_000n,
      });

      assert.equal(funds.funderPusdAvailableRaw, 5_150_000n);
      assert.equal(funds.signerLockedRaw, 100_000_000n);
      assert.equal(funds.signerPusdTopUpRaw, 700_000_000n);
      assert.equal(funds.signerUsdceTopUpRaw, 42_710_000n);
      assert.equal(funds.executableFundsRaw, 747_860_000n);
    },
  },
  {
    name: "max spend rejects below-min-order funds and accepts min-size funds",
    run: () => {
      const context = quoteContext({
        marketInfo: { ...baseMarketInfo, taker_fee_bps: "0" },
      });
      const belowMin = findMaxPolymarketMarketBuyUsd({
        context,
        tokenId: "token-yes",
        executableFundsRaw: 2_490_000n,
      });
      const atMin = findMaxPolymarketMarketBuyUsd({
        context,
        tokenId: "token-yes",
        executableFundsRaw: 2_500_000n,
      });

      assert.equal(belowMin, null);
      assert.ok(atMin);
      assert.equal(atMin.maxAmountUsdRaw, "2500000");
      assert.equal(atMin.quote.violatesMinOrderSize, false);
    },
  },
  {
    name: "max spend can be capped by available ask depth",
    run: () => {
      const context = noFeeNoMinContext();
      context.orderbook.asks = [{ price: 0.5, size: 8 }];

      const capped = findMaxPolymarketMarketBuyUsd({
        context,
        tokenId: "token-yes",
        executableFundsRaw: 10_000_000n,
        requireOrderbookDepth: true,
      });
      const uncapped = findMaxPolymarketMarketBuyUsd({
        context,
        tokenId: "token-yes",
        executableFundsRaw: 10_000_000n,
      });

      assert.ok(capped);
      assert.ok(uncapped);
      assert.equal(capped.maxAmountUsdRaw, "4000000");
      assert.equal(capped.quote.takerAmount, "8000000");
      assert.equal(uncapped.maxAmountUsdRaw, "10000000");
    },
  },
  {
    name: "CLOB open-order locks include requested BUY wallet collateral only",
    run: () => {
      const locks = computePolymarketClobOpenOrderLocks({
        wallets: ["0xFunder000000000000000000000000000000000000"],
        orders: [
          {
            maker_address: "0xFunder000000000000000000000000000000000000",
            side: "BUY",
            price: "0.4",
            original_size: "10",
            size_matched: "2",
            type: "GTC",
          },
          {
            maker_address: "0xFunder000000000000000000000000000000000000",
            side: "SELL",
            price: "0.4",
            original_size: "10",
            size_matched: "0",
            type: "GTC",
          },
          {
            maker_address: "0xFunder000000000000000000000000000000000000",
            side: "BUY",
            price: "0.4",
            original_size: "10",
            size_matched: "0",
            type: "FOK",
          },
          {
            maker_address: "0xOther0000000000000000000000000000000000000",
            side: "BUY",
            price: "0.4",
            original_size: "10",
            size_matched: "0",
            type: "GTC",
          },
        ],
      });

      assert.equal(
        locks.get("0xfunder000000000000000000000000000000000000"),
        3_200_000n,
      );
      assert.equal(locks.size, 1);
    },
  },
  {
    name: "builder fee lowers max spend",
    run: () => {
      const executableFundsRaw = 100_000_000n;
      const withoutBuilder = findMaxPolymarketMarketBuyUsd({
        context: quoteContext({
          marketInfo: { ...baseMarketInfo, taker_fee_bps: "0" },
        }),
        tokenId: "token-yes",
        executableFundsRaw,
      });
      const withBuilder = findMaxPolymarketMarketBuyUsd({
        context: quoteContext({
          marketInfo: { ...baseMarketInfo, taker_fee_bps: "0" },
          feePolicySnapshot: builderFeePolicy(100),
        }),
        tokenId: "token-yes",
        executableFundsRaw,
      });

      assert.ok(withoutBuilder);
      assert.ok(withBuilder);
      assert.ok(
        Number(withBuilder.maxAmountUsdRaw) <
          Number(withoutBuilder.maxAmountUsdRaw),
      );
    },
  },
  {
    name: "market buy slippage is reflected in final quote price and size",
    run: () => {
      const context = quoteContext({
        marketInfo: { ...baseMarketInfo, taker_fee_bps: "0" },
      });
      const normal = findMaxPolymarketMarketBuyUsd({
        context,
        tokenId: "token-yes",
        executableFundsRaw: 100_000_000n,
      });
      const slipped = findMaxPolymarketMarketBuyUsd({
        context,
        tokenId: "token-yes",
        executableFundsRaw: 100_000_000n,
        slippageBps: 200,
      });

      assert.ok(normal);
      assert.ok(slipped);
      assert.ok(slipped.quote.price > normal.quote.price);
      assert.ok(slipped.quote.size < normal.quote.size);
    },
  },
  {
    name: "no liquidity throws explicit quote error",
    run: () => {
      assert.throws(
        () =>
          findMaxPolymarketMarketBuyUsd({
            context: quoteContext({
              orderbook: {
                bids: [],
                asks: [],
                tickSize: 0.01,
                minOrderSize: 5,
                negRisk: false,
              },
            }),
            tokenId: "token-yes",
            executableFundsRaw: 100_000_000n,
          }),
        (error) =>
          error instanceof PolymarketQuoteError &&
          error.reason === "missing_top_of_book",
      );
    },
  },
  {
    name: "buy approval helper uses high allowance threshold",
    run: () => {
      assert.equal(
        polymarketAllowanceSatisfiesBuyApproval(
          POLYMARKET_BUY_APPROVAL_THRESHOLD - 1n,
        ),
        false,
      );
      assert.equal(
        polymarketAllowanceSatisfiesBuyApproval(
          POLYMARKET_BUY_APPROVAL_THRESHOLD,
        ),
        true,
      );
    },
  },
  {
    name: "normal market approval readiness requires only normal exchange",
    run: () => {
      assert.deepEqual(
        evaluatePolymarketBuyApprovalReadiness({
          allowanceExchange: POLYMARKET_BUY_APPROVAL_THRESHOLD,
          allowanceNegRisk: 0n,
          allowanceNegRiskAdapter: 0n,
          negRisk: false,
          negRiskAdapterConfigured: true,
        }),
        { missing: [], ok: true },
      );
    },
  },
  {
    name: "neg-risk approval readiness requires exchange and adapter",
    run: () => {
      assert.deepEqual(
        evaluatePolymarketBuyApprovalReadiness({
          allowanceExchange: POLYMARKET_BUY_APPROVAL_THRESHOLD,
          allowanceNegRisk: POLYMARKET_BUY_APPROVAL_THRESHOLD,
          allowanceNegRiskAdapter: 0n,
          negRisk: true,
          negRiskAdapterConfigured: true,
        }),
        { missing: ["negRiskAdapter"], ok: false },
      );
    },
  },
  {
    name: "unknown market approval readiness fails closed for both venues",
    run: () => {
      assert.deepEqual(
        evaluatePolymarketBuyApprovalReadiness({
          allowanceExchange: 0n,
          allowanceNegRisk: 0n,
          allowanceNegRiskAdapter: null,
          negRisk: null,
          negRiskAdapterConfigured: false,
        }),
        { missing: ["exchange", "negRiskExchange"], ok: false },
      );
    },
  },
  {
    name: "funding planner creates one mixed router call for the exact shortfall",
    run: () => {
      const plan = buildPolymarketFundingPlan({
        signer: SIGNER,
        depositWallet: DEPOSIT,
        routerAddress: ROUTER,
        routerNonce: 7n,
        requiredRaw: 1_060_000n,
        depositPusdRaw: 100_000n,
        depositUsdceRaw: 0n,
        depositRouterUsdceAllowanceRaw: 0n,
        depositLockedRaw: 20_000n,
        signerPusdRaw: 400_000n,
        signerLockedRaw: 50_000n,
        signerUsdceRaw: 630_000n,
        routerPusdAllowanceRaw: 350_000n,
        routerUsdceAllowanceRaw: 630_000n,
        fundingCapRaw: 2_200_000n,
      });
      assert.ok(plan);
      assert.equal(plan.depositAvailableRaw, "80000");
      assert.equal(plan.totalAmountRaw, "980000");
      assert.equal(plan.pUsdAmountRaw, "350000");
      assert.equal(plan.usdceAmountRaw, "630000");
      assert.deepEqual(decodePolymarketFundingCalldata(plan.calldata), {
        expectedNonce: 7n,
        totalAmount: 980_000n,
        pUsdAmount: 350_000n,
      });
    },
  },
  {
    name: "funding planner returns no operation when deposit funds are sufficient",
    run: () => {
      assert.equal(
        buildPolymarketFundingPlan({
          signer: SIGNER,
          depositWallet: DEPOSIT,
          routerAddress: ROUTER,
          routerNonce: 0n,
          requiredRaw: 1_000_000n,
          depositPusdRaw: 1_200_000n,
          depositUsdceRaw: 0n,
          depositRouterUsdceAllowanceRaw: 0n,
          depositLockedRaw: 100_000n,
          signerPusdRaw: 0n,
          signerUsdceRaw: 0n,
          routerPusdAllowanceRaw: 0n,
          routerUsdceAllowanceRaw: 0n,
          fundingCapRaw: 2_200_000n,
        }),
        null,
      );
    },
  },
  {
    name: "funding planner uses deposit USDC.e before signer collateral",
    run: () => {
      const plan = buildPolymarketFundingPlan({
        signer: SIGNER,
        depositWallet: DEPOSIT,
        routerAddress: ROUTER,
        routerNonce: 3n,
        requiredRaw: 1_060_000n,
        depositPusdRaw: 60_000n,
        depositUsdceRaw: 700_000n,
        depositRouterUsdceAllowanceRaw: 700_000n,
        signerPusdRaw: 200_000n,
        signerUsdceRaw: 100_000n,
        routerPusdAllowanceRaw: 200_000n,
        routerUsdceAllowanceRaw: 100_000n,
        fundingCapRaw: 2_200_000n,
      });
      assert.ok(plan);
      assert.equal(plan.totalAmountRaw, "1000000");
      assert.equal(plan.depositUsdceAmountRaw, "700000");
      assert.equal(plan.pUsdAmountRaw, "200000");
      assert.equal(plan.signerUsdceAmountRaw, "100000");
      assert.equal(plan.usdceAmountRaw, "800000");
    },
  },
  {
    name: "funding planner fails closed on cap, balance, and allowance",
    run: () => {
      const base = {
        signer: SIGNER,
        depositWallet: DEPOSIT,
        routerAddress: ROUTER,
        routerNonce: 0n,
        requiredRaw: 1_060_000n,
        depositPusdRaw: 0n,
        depositUsdceRaw: 0n,
        depositRouterUsdceAllowanceRaw: 0n,
        signerPusdRaw: 500_000n,
        signerUsdceRaw: 560_000n,
        routerPusdAllowanceRaw: 500_000n,
        routerUsdceAllowanceRaw: 560_000n,
        fundingCapRaw: 2_200_000n,
      };
      assert.throws(
        () => buildPolymarketFundingPlan({ ...base, fundingCapRaw: 1n }),
        (error) =>
          error instanceof PolymarketFundingPlanError &&
          error.code === "cap_exceeded",
      );
      assert.throws(
        () => buildPolymarketFundingPlan({ ...base, signerUsdceRaw: 1n }),
        (error) =>
          error instanceof PolymarketFundingPlanError &&
          error.code === "insufficient_balance",
      );
      assert.throws(
        () =>
          buildPolymarketFundingPlan({
            ...base,
            routerUsdceAllowanceRaw: 1n,
          }),
        (error) =>
          error instanceof PolymarketFundingPlanError &&
          error.code === "allowance_missing",
      );
    },
  },
];

let passed = 0;
for (const test of tests) {
  await test.run();
  passed += 1;
  console.log(`[polymarket-max-spend-tests] ok ${test.name}`);
}

console.log(`[polymarket-max-spend-tests] passed ${passed}/${tests.length}`);
