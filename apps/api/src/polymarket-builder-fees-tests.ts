#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  buildPolymarketBuilderFeeAccrual,
  type PolymarketBuilderFeeConfig,
  type PolymarketFeePolicySnapshot,
  validatePolymarketOrderBuilderCodeForConfig,
} from "./services/polymarket-builder-fees.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const fallbackConfig: PolymarketBuilderFeeConfig = {
  active: true,
  builderCode:
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  takerFeeBps: 100,
  makerFeeBps: 50,
};

const builderSnapshot: PolymarketFeePolicySnapshot = {
  venue: "polymarket",
  collectionMode: "builder",
  builderCode:
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  builderTakerFeeBps: 50,
  builderMakerFeeBps: 25,
  legacyFeeBps: 0,
  feePolicyId: "policy-1",
  capturedAt: "2026-05-19T00:00:00.000Z",
};

function baseInput() {
  return {
    userId: "00000000-0000-4000-8000-000000000001",
    walletAddress: "0x1111111111111111111111111111111111111111",
    signerAddress: "0x2222222222222222222222222222222222222222",
    orderId: "00000000-0000-4000-8000-000000000002",
    orderHash:
      "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    venueOrderId: "order-1",
    venueFillId: "trade-1:taker",
    venueTradeId: "trade-1",
    txHash:
      "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    tokenId: "123",
    side: "BUY" as const,
    role: "taker" as const,
    size: "4",
    price: "0.249",
    filledAt: new Date("2026-05-19T00:01:00.000Z"),
    orderBuilderCode: builderSnapshot.builderCode,
    feePolicySnapshot: builderSnapshot,
  };
}

test("uses frozen builder policy snapshot for accrual math", () => {
  const accrual = buildPolymarketBuilderFeeAccrual(
    baseInput(),
    fallbackConfig,
  );

  assert.ok(accrual);
  assert.equal(accrual.attributionCode, builderSnapshot.builderCode);
  assert.equal(accrual.feeRateBps, 50);
  assert.equal(accrual.notionalAmountRaw, "996000");
  assert.equal(accrual.notionalAmount, "0.996000");
  assert.equal(accrual.feeAmountRaw, "4980");
  assert.equal(accrual.feeAmount, "0.004980");
});

test("does not accrue when frozen policy was legacy fee-auth", () => {
  const accrual = buildPolymarketBuilderFeeAccrual(
    {
      ...baseInput(),
      feePolicySnapshot: {
        ...builderSnapshot,
        collectionMode: "fee_auth",
      },
      orderBuilderCode: fallbackConfig.builderCode,
    },
    fallbackConfig,
  );

  assert.equal(accrual, null);
});

test("falls back to current config only for older orders without a snapshot", () => {
  const accrual = buildPolymarketBuilderFeeAccrual(
    {
      ...baseInput(),
      orderBuilderCode: fallbackConfig.builderCode,
      feePolicySnapshot: null,
    },
    fallbackConfig,
  );

  assert.ok(accrual);
  assert.equal(accrual.attributionCode, fallbackConfig.builderCode);
  assert.equal(accrual.feeRateBps, fallbackConfig.takerFeeBps);
});

test("allows builder attribution when configured rates are zero", () => {
  const zeroRateConfig: PolymarketBuilderFeeConfig = {
    active: true,
    builderCode:
      "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    takerFeeBps: 0,
    makerFeeBps: 0,
  };

  const validation = validatePolymarketOrderBuilderCodeForConfig(
    zeroRateConfig.builderCode,
    zeroRateConfig,
  );
  assert.equal(validation.ok, true);

  const accrual = buildPolymarketBuilderFeeAccrual(
    {
      ...baseInput(),
      orderBuilderCode: zeroRateConfig.builderCode,
      feePolicySnapshot: {
        ...builderSnapshot,
        builderCode: zeroRateConfig.builderCode,
        builderTakerFeeBps: 0,
        builderMakerFeeBps: 0,
      },
    },
    zeroRateConfig,
  );
  assert.equal(accrual, null);
});
