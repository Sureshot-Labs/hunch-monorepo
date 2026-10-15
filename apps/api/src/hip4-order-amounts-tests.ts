import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateHip4OrderAmounts,
  type Hip4OrderAmountInput,
} from "./services/hip4-order-amounts.js";

const input: Hip4OrderAmountInput = {
  environment: "mainnet",
  side: "BUY",
  timeInForce: "Gtc",
  limitPrice: "0.5",
  quantity: "2",
  policy: { revision: "policy-1", minimumBuyNotionalUsd: "1.00" },
  feeCapRaw: "0",
  consentedDebitCapRaw: "100000000",
};

function amounts(overrides: Partial<Hip4OrderAmountInput> = {}) {
  const result = calculateHip4OrderAmounts({ ...input, ...overrides });
  if (result.kind !== "calculated") assert.fail(result.reason);
  return result;
}

test("SELL is independent of the BUY-only product minimum policy", () => {
  const sell = amounts({
    side: "SELL",
    policy: undefined,
    consentedDebitCapRaw: "200000",
  });
  assert.equal(sell.validation.valid, true);
  assert.equal(sell.policyRevision, null);
  assert.equal(sell.minimum, null);
});

test("HIP new BUY minimum is inclusive and independent of fee or TIF", () => {
  for (const timeInForce of ["Gtc", "Ioc", "Alo"] as const) {
    assert.deepEqual(amounts({ timeInForce }).validation, {
      valid: true,
      reason: null,
    });
    const below = amounts({
      timeInForce,
      limitPrice: "0.495",
      feeCapRaw: "1000000",
    });
    assert.equal(below.grossQuoteRaw, "99000000");
    assert.equal(below.debitCapRaw, "100000000");
    assert.equal(below.validation.reason, "buy_below_minimum");
  }
});

test("price-dependent minimum reports whole lots without increasing the order", () => {
  for (const [price, quantity, notional] of [
    ["0.5", "2", "100000000"],
    ["0.415", "3", "124500000"],
    ["0.01", "100", "100000000"],
  ]) {
    const result = amounts({ limitPrice: price, quantity: "1" });
    assert.equal(result.quantity, "1");
    assert.equal(result.minimum?.quantity, quantity);
    assert.equal(result.minimum?.normalizedNotionalRaw, notional);
    assert.equal(result.validation.reason, "buy_below_minimum");
  }
  assert.equal(
    amounts({ limitPrice: "0.415", quantity: "3" }).validation.reason,
    "consented_debit_exceeded",
    "advice does not authorize increasing a $1 budget to $1.245",
  );
});

test("normalization cannot worsen a limit or turn a fractional lot into an order", () => {
  const buy = amounts({ limitPrice: "0.499999", quantity: "2.99999" });
  assert.equal(buy.limitPrice, "0.49999");
  assert.equal(buy.quantity, "2");
  assert.equal(buy.tokenRaw, "200000");
  assert.equal(buy.grossQuoteRaw, "99998000");
  assert.equal(buy.validation.reason, "buy_below_minimum");
  const sell = amounts({
    side: "SELL",
    limitPrice: "0.500001",
    quantity: "2.99999",
  });
  assert.equal(sell.limitPrice, "0.50001");
  assert.equal(sell.quantity, "2");
  assert.equal(sell.validation.valid, true);
  assert.deepEqual(
    calculateHip4OrderAmounts({ ...input, quantity: "0.99999" }),
    { kind: "invalid", reason: "quantity_below_lot" },
  );
});

test("policy revision and floor survive exact quote-atom normalization", () => {
  const raised = amounts({
    policy: { revision: "policy-2", minimumBuyNotionalUsd: "2" },
  });
  assert.equal(raised.policyRevision, "policy-2");
  assert.equal(raised.minimum?.effectiveQuoteRaw, "200000000");
  assert.equal(raised.validation.reason, "buy_below_minimum");
  const lower = amounts({
    policy: { revision: "policy-3", minimumBuyNotionalUsd: "0.1" },
  });
  assert.equal(lower.minimum?.productQuoteRaw, "10000000");
  assert.equal(lower.minimum?.effectiveQuoteRaw, "100000000");
  assert.equal(lower.validation.valid, true);
  for (const policyFloor of ["1.00000001", "1.000000001"]) {
    const oneAtom = amounts({
      policy: { revision: "policy-4", minimumBuyNotionalUsd: policyFloor },
    });
    assert.equal(oneAtom.minimum?.effectiveQuoteRaw, "100000001");
    assert.equal(oneAtom.validation.reason, "buy_below_minimum");
  }
  assert.equal(
    amounts().policyRevision,
    "policy-1",
    "no policy retained between calls",
  );
});

test("missing financial policy or fees never become an implicit default or zero", () => {
  for (const minimumBuyNotionalUsd of [
    "",
    "0",
    "0.00",
    "-1",
    "1e0",
    "NaN",
    "01",
    "1".repeat(129),
  ]) {
    assert.deepEqual(
      calculateHip4OrderAmounts({
        ...input,
        policy: { revision: "policy", minimumBuyNotionalUsd },
      }),
      { kind: "invalid", reason: "invalid_policy" },
    );
  }
  assert.deepEqual(
    calculateHip4OrderAmounts({
      ...input,
      policy: { revision: " ", minimumBuyNotionalUsd: "1" },
    }),
    { kind: "invalid", reason: "invalid_policy" },
  );
  for (const feeCapRaw of [null, "", "01", "-1", "0.1", "1e2"]) {
    assert.deepEqual(calculateHip4OrderAmounts({ ...input, feeCapRaw }), {
      kind: "invalid",
      reason: "fee_unavailable",
    });
  }
});

test("total fee cap is charged once and never relaxes the exact consent cap", () => {
  const feeCapRaw = "5";
  assert.equal(
    amounts({ feeCapRaw }).validation.reason,
    "consented_debit_exceeded",
  );
  const accepted = amounts({ feeCapRaw, consentedDebitCapRaw: "100000005" });
  assert.equal(accepted.validation.valid, true);
  assert.equal(accepted.debitAsset, "quote");
  assert.equal(accepted.debitCapRaw, "100000005");
  assert.equal(accepted.grossQuoteRaw, "100000000");
  assert.equal(accepted.feeCapRaw, "5");
});

test("sub-$1 SELL does not inherit BUY minimum or authorize extra owned quantity", () => {
  // Arithmetic for the pinned observed close; not proof every tiny SELL is accepted.
  const close = amounts({
    side: "SELL",
    timeInForce: "Ioc",
    quantity: "100",
    limitPrice: "0.00333",
    feeCapRaw: "44755",
    consentedDebitCapRaw: "10000000",
  });
  assert.equal(close.validation.valid, true);
  assert.equal(close.grossQuoteRaw, "33300000");
  assert.equal(close.minimumNetProceedsRaw, "33255245");
  assert.equal(close.debitAsset, "outcome");
  assert.equal(close.debitCapRaw, "10000000");
  assert.equal(close.minimum, null);
  assert.equal(close.sellMinimumKnown, false);
  assert.equal(
    amounts({ side: "SELL", consentedDebitCapRaw: "199999" }).validation.reason,
    "consented_debit_exceeded",
  );
  assert.equal(
    amounts({ side: "SELL", feeCapRaw: "100000001" }).validation.reason,
    "fee_exceeds_proceeds",
  );
});

test("exact quantities beyond JS safe integer do not silently lose shares or cash", () => {
  const result = amounts({
    quantity: "9007199254740993",
    limitPrice: "0.00001",
    consentedDebitCapRaw: "9007199254740993000",
  });
  assert.equal(result.validation.valid, true);
  assert.equal(result.quantity, "9007199254740993");
  assert.equal(result.grossQuoteRaw, "9007199254740993000");
  assert.equal(result.tokenRaw, "900719925474099300000");
  assert.equal(result.limitPrice, "0.00001");
});

test("invalid decimals and endpoint prices fail explicitly with ordinary recovery", () => {
  for (const limitPrice of ["0", "1", "2", "0.000001"]) {
    assert.deepEqual(calculateHip4OrderAmounts({ ...input, limitPrice }), {
      kind: "invalid",
      reason: "price_out_of_range",
    });
  }
  assert.deepEqual(
    calculateHip4OrderAmounts({
      ...input,
      side: "SELL",
      limitPrice: "0.999999",
    }),
    {
      kind: "invalid",
      reason: "price_out_of_range",
    },
  );
  for (const limitPrice of ["NaN", "-0.5", "5e-1", " .5", "0,5"]) {
    assert.deepEqual(calculateHip4OrderAmounts({ ...input, limitPrice }), {
      kind: "invalid",
      reason: "invalid_order_amount",
    });
  }
  assert.deepEqual(
    calculateHip4OrderAmounts({ ...input, environment: "testnet" }),
    {
      kind: "invalid",
      reason: "unsupported_environment",
    },
  );
  assert.equal(amounts().validation.valid, true);
});
