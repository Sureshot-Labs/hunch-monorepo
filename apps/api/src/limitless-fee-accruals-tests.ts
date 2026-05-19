#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  buildLimitlessVenueShareAccrualFromStatus,
  type LimitlessAccrualOrderRow,
  type LimitlessFeeShareConfig,
  type LimitlessOrderStatusItem,
} from "./services/limitless-fee-accruals.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const config: LimitlessFeeShareConfig = {
  active: true,
  shareBps: 1_000,
};

function baseOrder(): LimitlessAccrualOrderRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    user_id: "00000000-0000-4000-8000-000000000002",
    wallet_address: "0x1111111111111111111111111111111111111111",
    signer_address: "0x2222222222222222222222222222222222222222",
    venue_order_id: "limitless-order-1",
    order_hash: "limitless-order-hash-1",
    token_id: "123",
    side: "BUY",
    filled_at: new Date("2026-05-19T00:00:00.000Z"),
    last_update: null,
    posted_at: null,
  };
}

function statusWithTotals(totalsRaw: Record<string, string>): LimitlessOrderStatusItem {
  return {
    orderId: "limitless-order-1",
    payload: {
      status: "found",
      orderId: "limitless-order-1",
      data: {
        order: {
          order: {
            side: 0,
            tokenId: "456",
          },
        },
        execution: {
          matched: true,
          settlementStatus: "MINED",
          tradeEventId: "trade-1",
          txHash:
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          feeRateBps: 25,
          effectiveFeeBps: 20,
          totalsRaw,
        },
      },
    },
  };
}

test("builds Limitless accrual from USD-denominated venue fee", () => {
  const accrual = buildLimitlessVenueShareAccrualFromStatus({
    order: baseOrder(),
    status: statusWithTotals({
      usdGross: "1000000",
      usdFee: "10000",
      contractsGross: "2000000",
      contractsFee: "0",
    }),
    config,
  });

  assert.ok(accrual);
  assert.equal(accrual.feeAsset, "USDC");
  assert.equal(accrual.feeBasis, "venue_fee_share");
  assert.equal(accrual.notionalAmountRaw, "1000000");
  assert.equal(accrual.feeAmountRaw, "1000");
  assert.equal(accrual.feeAmount, "0.001000");
  assert.equal(accrual.venueFeeAmountRaw, "10000");
  assert.equal(accrual.venueFeeAmount, "0.010000");
  assert.equal(accrual.venueFeeRateBps, 25);
  assert.equal(accrual.venueEffectiveFeeBps, 20);
});

test("does not create rewards accrual for contract-denominated fee", () => {
  const accrual = buildLimitlessVenueShareAccrualFromStatus({
    order: baseOrder(),
    status: statusWithTotals({
      usdGross: "1000000",
      usdFee: "0",
      contractsGross: "2000000",
      contractsFee: "10000",
    }),
    config,
  });

  assert.equal(accrual, null);
});

test("does not create rewards accrual when fee share rounds to zero", () => {
  const accrual = buildLimitlessVenueShareAccrualFromStatus({
    order: baseOrder(),
    status: statusWithTotals({
      usdGross: "1000000",
      usdFee: "9",
      contractsGross: "2000000",
      contractsFee: "0",
    }),
    config,
  });

  assert.equal(accrual, null);
});
