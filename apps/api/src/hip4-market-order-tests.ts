import assert from "node:assert/strict";
import { test } from "node:test";
import { hip4Identity } from "@hunch/shared";
import {
  sizeHip4MarketOrder,
  hip4MarketOrderQuoteRequestSchema,
} from "./services/hip4-market-order.js";
import { calculateHip4OrderAmounts } from "./services/hip4-order-amounts.js";

const now = Date.parse("2026-10-15T12:00:00.000Z");
const request = {
  ...hip4MarketOrderQuoteRequestSchema.parse({
    requestKey: "00000000-0000-4000-8000-000000000001",
    controllerWalletRef: "00000000-0000-4000-8000-000000000002",
    marketId: "hyperliquid:mainnet:outcome:1473",
    outcomeSide: "NO",
    side: "BUY",
    consentedDebitCapRaw: "1000000000",
    slippageBps: 100,
  }),
  slippageBps: 100,
};
const level = (px: string, sz: string) => ({ px, sz, n: 1 });
function book() {
  return {
    coin: hip4Identity("mainnet", 1473).sides[1].coin,
    time: now - 500,
    levels: [
      [level("0.49", "10"), level("0.489", "10")],
      [level("0.5", "3"), level("0.501", "5"), level("0.51", "100")],
    ],
  };
}
function size(
  overrides: Partial<Parameters<typeof sizeHip4MarketOrder>[0]> = {},
) {
  return sizeHip4MarketOrder({
    request,
    book: book(),
    now,
    bookMaxAgeMs: 1000,
    ...overrides,
  });
}

test("market BUY sizes quote atoms at the worst permitted price, not displayed VWAP", () => {
  const result = size();
  assert.equal(result.preparationRequest.limitPrice, "0.505");
  assert.equal(result.preparationRequest.quantity, "19");
  assert.equal(result.preparationRequest.timeInForce, "Ioc");
  assert.equal(result.preparationRequest.consentedDebitCapRaw, "1000000000");
  assert.equal(result.executionEstimate.estimatedFillQuantity, "8");
  assert.equal(result.executionEstimate.estimatedUnfilledQuantity, "11");
  assert.equal(result.executionEstimate.estimatedGrossQuoteRaw, "400500000");
  assert.equal(result.executionEstimate.partialFillPossible, true);
  assert.equal(result.executionEstimate.guaranteed, false);
  assert.equal(
    result.executionEstimate.expiresAt,
    new Date(now + 500).toISOString(),
  );
  const exact = calculateHip4OrderAmounts({
    ...result.preparationRequest,
    environment: "mainnet",
    policy: { revision: "test", minimumBuyNotionalUsd: "1" },
    feeCapRaw: "0",
  });
  assert.equal(exact.kind, "calculated");
  if (exact.kind !== "calculated") assert.fail();
  assert.equal(exact.validation.valid, true);
  assert.equal(exact.debitCapRaw, "959500000");
});

test("SELL preserves the outcome-token cap and rounds the limit inward", () => {
  const result = size({
    request: { ...request, side: "SELL", consentedDebitCapRaw: "1500001" },
  });
  assert.equal(result.preparationRequest.quantity, "15");
  assert.equal(result.preparationRequest.limitPrice, "0.4851");
  assert.equal(result.executionEstimate.estimatedFillQuantity, "15");
  assert.equal(result.executionEstimate.estimatedGrossQuoteRaw, "734500000");
  assert.equal(result.executionEstimate.estimatedUnfilledQuantity, "0");
});

test("zero slippage and tick rounding never worsen price consent", () => {
  for (const side of ["BUY", "SELL"] as const) {
    const quoted = size({ request: { ...request, side, slippageBps: 0 } });
    assert.equal(
      quoted.preparationRequest.limitPrice,
      side === "BUY" ? "0.5" : "0.49",
    );
  }
  const sparse = book();
  sparse.levels = [[level("0.33333", "20")], [level("0.33334", "20")]];
  const buy = size({ book: sparse, request: { ...request, slippageBps: 1 } });
  const sell = size({
    book: sparse,
    request: { ...request, side: "SELL", slippageBps: 1 },
  });
  assert.equal(buy.preparationRequest.limitPrice, "0.33337");
  assert.equal(sell.preparationRequest.limitPrice, "0.3333");
});

test("endpoint clamping respects protocol ticks and never authorizes price zero or one", () => {
  const sparse = book();
  sparse.levels = [[level("0.00001", "20")], [level("0.99999", "20")]];
  assert.equal(
    size({ book: sparse, request: { ...request, slippageBps: 10_000 } })
      .preparationRequest.limitPrice,
    "0.99999",
  );
  assert.equal(
    size({
      book: sparse,
      request: { ...request, side: "SELL", slippageBps: 10_000 },
    }).preparationRequest.limitPrice,
    "0.00001",
  );
});

test("small budgets never grow to satisfy the shared BUY minimum", () => {
  const result = size({
    request: { ...request, consentedDebitCapRaw: "100000000" },
  });
  assert.equal(result.preparationRequest.quantity, "1");
  const exact = calculateHip4OrderAmounts({
    ...result.preparationRequest,
    environment: "mainnet",
    policy: { revision: "test", minimumBuyNotionalUsd: "1" },
    feeCapRaw: "0",
  });
  assert.equal(
    exact.kind === "calculated" && exact.validation.reason,
    "buy_below_minimum",
  );
  for (const side of ["BUY", "SELL"] as const) {
    assert.throws(
      () => size({ request: { ...request, side, consentedDebitCapRaw: "1" } }),
      /quantity_below_lot/u,
    );
  }
});

test("exact huge raw budgets do not pass through Number", () => {
  const cap = "9007199254740993100000000";
  const quoted = size({
    request: { ...request, slippageBps: 0, consentedDebitCapRaw: cap },
  });
  assert.equal(
    quoted.preparationRequest.quantity,
    (BigInt(cap) / 50000000n).toString(),
  );
});

test("stale, future and wrong-side books reject; the next fresh observation recovers", () => {
  for (const time of [now - 1000, now + 1])
    assert.throws(() => size({ book: { ...book(), time } }), /book_stale/u);
  assert.throws(
    () => size({ book: { ...book(), coin: "#14730" } }),
    /identity_mismatch/u,
  );
  assert.ok(size({ book: { ...book(), time: now } }));
});

test("unknown/invalid depth is not silently quoted as zero or sorted into apparent liquidity", () => {
  for (const levels of [
    [[level("0.5", "1")], [level("0.5", "2")]],
    [[level("0.49", "1"), level("0.499", "1")], [level("0.5", "2")]],
    [[], [level("0.51", "1"), level("0.5", "2")]],
    [[], [level("0.5", "1"), level("0.5", "2")]],
    [[], [level("0.5", "1.5")]],
    [[], [level("0.500001", "1")]],
    [[], [level("1", "1")]],
    [[], [level("0", "1")]],
    [[], [level("0.5", "0")]],
    [[], [{ ...level("0.5", "1"), n: 0 }]],
  ])
    assert.throws(() => size({ book: { ...book(), levels } }), /book_invalid/u);
  assert.throws(
    () => size({ book: { ...book(), levels: [[], []] } }),
    /no_liquidity/u,
  );
  assert.ok(
    size({ book: { ...book(), levels: [[], [level("0.5", "1")]] } }),
    "the unneeded side may be empty",
  );
});

test("slippage is explicit or resolved by runtime policy, never defaulted by the sizing primitive", () => {
  assert.equal(
    hip4MarketOrderQuoteRequestSchema.safeParse({
      ...request,
      slippageBps: undefined,
    }).success,
    true,
  );
  assert.throws(() =>
    size({
      request: { ...request, slippageBps: undefined as unknown as number },
    }),
  );
  for (const slippageBps of [-1, 0.1, 10_001])
    assert.equal(
      hip4MarketOrderQuoteRequestSchema.safeParse({ ...request, slippageBps })
        .success,
      false,
    );
  for (const consentedDebitCapRaw of ["0", "-1", "1.5", "01", "1e8"])
    assert.equal(
      hip4MarketOrderQuoteRequestSchema.safeParse({
        ...request,
        consentedDebitCapRaw,
      }).success,
      false,
    );
  assert.equal(
    hip4MarketOrderQuoteRequestSchema.safeParse({
      ...request,
      limitPrice: "0.5",
    }).success,
    false,
  );
});
