import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "@hunch/infra";
import { checkHip4BuyBudget } from "./funding/planner/hip4-buy-budget.js";
import { suggestSmallerMarketBuy } from "./funding/planner/market-buy-suggestion.js";
import type { FundingPlanningSnapshot } from "./funding/planner/planning-types.js";
import type { AccountValueReadModel } from "./account-value/runtime-service.js";
import { DEFAULT_FUNDING_RUNTIME_POLICY } from "./funding/policies/funding-policy.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import { sizeHip4MarketOrder } from "./services/hip4-market-order.js";
import { calculateHip4OrderAmounts } from "./services/hip4-order-amounts.js";

const pool = {} as Pool;
const input = () => ({
  userId: "00000000-0000-4000-8000-000000000001",
  controllerWalletRef: "00000000-0000-4000-8000-000000000002",
  marketId: "hyperliquid:mainnet:outcome:1473",
  tokenId: "mainnet:14731",
  budgetRaw: 486999999n,
  slippageBps: 100,
  deadlineMs: Date.now() + 3000,
});
const result = (quantity = "9", filled = quantity, required = "454500000") => ({
  amounts: { quantity, debitCapRaw: required, grossQuoteRaw: required },
  executionEstimate: { estimatedFillQuantity: filled },
  expiresAfter: Date.now() + 2000,
});

test("native advice uses USDC8, the exact outcome and inward editable cents", async () => {
  for (const [tokenId, side] of [
    ["mainnet:14731", "NO"],
    ["hyperliquid:mainnet:14730", "YES"],
  ]) {
    const checked = await checkHip4BuyBudget(
      pool,
      { ...input(), tokenId },
      async (_, quote) => {
        assert.equal(quote.userId, input().userId);
        assert.equal(quote.actor, "web_app");
        assert.equal(
          quote.request.controllerWalletRef,
          input().controllerWalletRef,
        );
        assert.equal(quote.request.side, "BUY");
        assert.equal(quote.request.outcomeSide, side);
        assert.equal(quote.request.slippageBps, 100);
        assert.equal(quote.request.consentedDebitCapRaw, "486000000");
        return result();
      },
    );
    assert.equal(checked?.amountRaw, 486000000n);
    assert.equal(checked?.requiredRaw, 454500000n);
  }
});

test("partial depth generates one inward candidate and checks smaller economics again", async () => {
  const caps: string[] = [];
  const checked = await checkHip4BuyBudget(
    pool,
    { ...input(), budgetRaw: 1000000000n },
    async (_, quote) => {
      caps.push(quote.request.consentedDebitCapRaw);
      return caps.length === 1
        ? result("19", "8", "959500000")
        : result("8", "8", "404000000");
    },
  );
  assert.deepEqual(caps, ["1000000000", "404000000"]);
  assert.equal(checked?.amountRaw, 404000000n);
  assert.equal(checked?.requiredRaw, 404000000n);
  let calls = 0;
  assert.equal(
    await checkHip4BuyBudget(pool, input(), async () => {
      calls++;
      return calls === 1
        ? result("9", "4", "454500000")
        : result("4", "2", "202000000");
    }),
    null,
  );
  assert.equal(calls, 2, "moving depth cannot cause an unbounded search");
});

test("minimum and no-liquidity differ from unavailable fees, policy or transport", async () => {
  for (const [reason, expected] of [
    ["hip4_preparation_buy_below_minimum", undefined],
    ["hip4_preparation_quantity_below_lot", undefined],
    ["hip4_market_no_liquidity", undefined],
    ["hip4_market_book_stale", null],
    ["hip4_preparation_invalid_policy", null],
    ["hip4_preparation_fee_unavailable", null],
    ["hip4_preparation_consented_debit_exceeded", null],
  ] as const) {
    assert.equal(
      await checkHip4BuyBudget(pool, input(), async () => {
        throw new Error(reason);
      }),
      expected,
    );
  }
});

for (const [price, depth, expectedCap, expectedDebit] of [
  ["0.3", "4", "122000000", "121200000"],
  ["0.003", "400", "121000000", "120897000"],
] as const)
  test(`cent-editable depth at ${price} neither loses the minimum nor adds unavailable lots`, async () => {
    const caps: string[] = [];
    const checked = await checkHip4BuyBudget(
      pool,
      { ...input(), budgetRaw: 1000000000n },
      async (_, { request }) => {
        caps.push(request.consentedDebitCapRaw);
        assert.ok(request.slippageBps != null);
        const sized = sizeHip4MarketOrder({
          request: { ...request, slippageBps: request.slippageBps },
          book: {
            coin: "#14731",
            time: Date.now(),
            levels: [[], [{ px: price, sz: depth, n: 1 }]],
          },
          now: Date.now(),
          bookMaxAgeMs: 5000,
        });
        const amounts = calculateHip4OrderAmounts({
          ...sized.preparationRequest,
          environment: "mainnet",
          policy: { revision: "current", minimumBuyNotionalUsd: "1" },
          feeCapRaw: "0",
        });
        assert.equal(amounts.kind, "calculated");
        if (amounts.kind !== "calculated") throw new Error("unexpected amount");
        if (!amounts.validation.valid)
          throw new Error(`hip4_preparation_${amounts.validation.reason}`);
        return {
          amounts,
          executionEstimate: sized.executionEstimate,
          expiresAfter: Date.now() + 2000,
        };
      },
    );
    assert.deepEqual(caps, ["1000000000", expectedCap]);
    assert.equal(checked?.amountRaw, BigInt(expectedCap));
    assert.equal(checked?.requiredRaw, BigInt(expectedDebit));
  });

test("unknown context, expired advice and debit over cap never become affordability", async () => {
  for (const changed of [
    { tokenId: "mainnet:14740" },
    { marketId: "hyperliquid:testnet:outcome:1473" },
    { marketId: "hyperliquid:mainnet:outcome:999999999999999999999" },
    { deadlineMs: Date.now() - 1 },
  ])
    assert.equal(
      await checkHip4BuyBudget(pool, { ...input(), ...changed }, async () =>
        assert.fail("must not quote"),
      ),
      null,
    );
  for (const quoted of [
    result("0"),
    result("9", "10"),
    result("9", "9", "487000000"),
    { ...result(), expiresAfter: Date.now() - 1 },
  ])
    assert.equal(
      await checkHip4BuyBudget(pool, input(), async () => quoted),
      null,
    );
  const expired = input();
  assert.equal(
    await checkHip4BuyBudget(pool, expired, async () => {
      expired.deadlineMs = Date.now() - 1;
      return result("9", "4");
    }),
    null,
  );
});

function snapshot(): FundingPlanningSnapshot {
  const asset = HYPERCORE_MAINNET_USDC;
  const spend = { asset, raw: "908000000" };
  return {
    request: {
      purpose: "trade_shortfall",
      marketBuyAmountUsdCents: 908,
      marketBuySlippageBps: 125,
      marketContextId: "mainnet:14731",
      controllerWalletRef: input().controllerWalletRef,
      consumerIntent: {
        venueId: "hyperliquid",
        marketId: input().marketId,
        marketContextId: "mainnet:14731",
        side: "BUY",
        spend,
      },
      requestedDestinationAmount: spend,
    },
    destination: {
      target: {
        kind: "owned_location",
        location: {
          locationId: "native-cash",
          accountId: input().userId,
          asset,
        },
      },
      option: { controllerWalletId: "controller" },
      venueBinding: { controllerWalletId: "controller" },
    },
    projection: {
      venueId: "hyperliquid",
      completeness: "complete",
      freshness: "fresh",
      errors: [],
      reasonCodes: ["insufficient_liquidity"],
      sourceOptions: [],
      collateralAsset: asset,
      availableNowRaw: "486000000",
      requestedCollateralRaw: spend.raw,
      expiresAt: new Date(Date.now() + 10000).toISOString(),
    },
    sources: [],
  } as unknown as FundingPlanningSnapshot;
}
const account = {
  ownership: {
    wallets: [
      {
        walletId: "controller",
        controllerWalletRef: input().controllerWalletRef,
      },
    ],
  },
  projection: { components: [] },
} as unknown as AccountValueReadModel;
const wrongVenue = async () =>
  assert.fail("must not use another venue's quote arithmetic");

test("ordinary shortfall advice invokes the native adapter and retains its checked expiry", async () => {
  const expiry = Date.now() + 1500;
  const value = await suggestSmallerMarketBuy(
    pool,
    snapshot(),
    account,
    DEFAULT_FUNDING_RUNTIME_POLICY,
    wrongVenue,
    wrongVenue,
    async (_, requested) => {
      assert.equal(requested.budgetRaw, 486000000n);
      assert.equal(requested.userId, input().userId);
      assert.equal(requested.controllerWalletRef, input().controllerWalletRef);
      assert.equal(requested.slippageBps, 125);
      assert.equal(requested.tokenId, "mainnet:14731");
      return {
        amountRaw: 486000000n,
        requiredRaw: 454500000n,
        expiresAtMs: expiry,
      };
    },
  );
  assert.deepEqual(value, {
    originalAmountUsdCents: 908,
    amountUsdCents: 486,
    expiresAt: new Date(expiry).toISOString(),
  });
});

test("native advice excludes wrong units, other controllers, stale or unknown funding evidence", async () => {
  for (const change of [
    "units",
    "asset",
    "controller",
    "binding",
    "stale",
    "partial",
    "error",
  ] as const) {
    const value = structuredClone(snapshot());
    assert.ok(value.request.consumerIntent);
    assert.ok(value.destination);
    if (change === "units")
      Object.assign(value.projection, {
        collateralAsset: { ...HYPERCORE_MAINNET_USDC, decimals: 6 },
      });
    if (change === "asset")
      Object.assign(value.request.consumerIntent.spend, {
        asset: { ...HYPERCORE_MAINNET_USDC, assetId: "wrong" },
      });
    if (change === "controller")
      Object.assign(value.request, {
        controllerWalletRef: "another-controller",
      });
    if (change === "binding")
      Object.assign(value.destination.option, { controllerWalletId: "other" });
    if (change === "stale")
      Object.assign(value.projection, { freshness: "stale" });
    if (change === "partial")
      Object.assign(value.projection, { completeness: "partial" });
    if (change === "error")
      Object.assign(value.projection, {
        errors: [{ code: "rpc_unavailable" }],
      });
    assert.equal(
      await suggestSmallerMarketBuy(
        pool,
        value,
        account,
        DEFAULT_FUNDING_RUNTIME_POLICY,
        wrongVenue,
        wrongVenue,
        wrongVenue,
      ),
      undefined,
      change,
    );
  }
});

test("native shortfall caps at a smaller amount and preserves unavailable versus no useful advice", async () => {
  const value = snapshot();
  Object.assign(value.projection, { availableNowRaw: "1000000000" });
  for (const checked of [undefined, null]) {
    assert.equal(
      await suggestSmallerMarketBuy(
        pool,
        value,
        account,
        DEFAULT_FUNDING_RUNTIME_POLICY,
        wrongVenue,
        wrongVenue,
        async (_, requested) => {
          assert.equal(requested.budgetRaw, 907000000n);
          return checked;
        },
      ),
      checked,
    );
  }
});

test("native advice reuses frozen routes and rechecks their fee allowance against the smaller actual debit", async () => {
  const value = snapshot();
  const sourceAsset = {
    networkId: "evm:8453",
    assetId: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    decimals: 6,
  };
  const source = {
    kind: "owned_location",
    location: {
      kind: "wallet",
      locationId: "base-cash",
      accountId: input().userId,
      asset: sourceAsset,
      details: { walletId: "controller" },
    },
  };
  const minimum = { asset: HYPERCORE_MAINNET_USDC, raw: "8000000" };
  Object.assign(value.projection, { availableNowRaw: "492000000" });
  Object.assign(value, {
    sources: [
      {
        providerId: "relay",
        routeId: "frozen-base-core",
        compositeEligible: true,
        option: {
          source,
          sourceOptionId: "source",
          safeLabel: "Base USDC",
          minimumDestination: minimum,
          expectedDestination: minimum,
          fees: [
            {
              kind: "relay",
              amount: { asset: sourceAsset, raw: "1100000" },
              estimatedUsd: "1.10",
            },
          ],
          requiredActions: [{ kind: "evm_transaction", actor: "user" }],
          expiresAt: new Date(Date.now() + 10000).toISOString(),
        },
        commitPlan: {
          operation: { planKind: "wallet_route" },
          segments: [
            {
              providerId: "relay",
              quotedInput: { asset: sourceAsset, raw: "1180000" },
              quotedExpectedOutput: minimum,
              quotedMinOutput: minimum,
            },
          ],
          steps: [
            {
              state: "action_required",
              normalizedAction: { kind: "evm_transaction" },
              payerRequirement: "privy_sponsor",
            },
          ],
          reservations: [
            {
              mode: "subtract_available",
              locationId: "base-cash",
              rawAmount: "1180000",
            },
          ],
        },
      },
    ],
  });
  const budgets: bigint[] = [];
  const checked = await suggestSmallerMarketBuy(
    pool,
    value,
    account,
    {
      ...DEFAULT_FUNDING_RUNTIME_POLICY,
      placement: {
        ...DEFAULT_FUNDING_RUNTIME_POLICY.placement,
        minimumDestinationUsd: "0",
      },
    },
    wrongVenue,
    wrongVenue,
    async (_, requested) => {
      budgets.push(requested.budgetRaw);
      return {
        amountRaw: requested.budgetRaw,
        requiredRaw: budgets.length === 1 ? 500000000n : 450000000n,
        expiresAtMs: Date.now() + 2000,
      };
    },
  );
  assert.deepEqual(budgets, [500000000n, 492000000n]);
  assert.equal(checked?.amountUsdCents, 492);
});
