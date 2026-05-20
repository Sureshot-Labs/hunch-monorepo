#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  backfillLimitlessVenueShareAccruals,
  buildStoredLimitlessOrderStatusItem,
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

async function testAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const config: LimitlessFeeShareConfig = {
  active: true,
  shareBps: 1_000,
  effectiveAt: null,
  source: "env",
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
    order_payload: null,
  };
}

function statusWithTotals(
  totalsRaw: Record<string, string>,
): LimitlessOrderStatusItem {
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

test("builds Limitless status item from stored upstream payload", () => {
  const order = {
    ...baseOrder(),
    client_order_id: "hunch-test-client-order",
    order_payload: {
      history: {},
      submitted: {
        clientOrderId: "hunch-test-client-order",
        _hunchUpstream: {
          order: {
            execution: {
              matched: true,
              settlementStatus: "CONFIRMED",
              totalsRaw: {
                usdGross: "1000000",
                usdFee: "10000",
              },
            },
          },
        },
      },
    },
  };

  const status = buildStoredLimitlessOrderStatusItem(order);
  assert.ok(status);
  assert.equal(status.orderId, "limitless-order-1");
  assert.equal(status.payload.clientOrderId, "hunch-test-client-order");
  assert.deepEqual(status.payload.data, {
    order: {
      execution: {
        matched: true,
        settlementStatus: "CONFIRMED",
        totalsRaw: {
          usdGross: "1000000",
          usdFee: "10000",
        },
      },
    },
  });
});

await testAsync(
  "backfill filters candidates by order-time policy and backfill attempts",
  async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      async query(sql: string, params: unknown[] = []) {
        queries.push({ sql, params });
        if (sql.includes("from fee_policy") && !sql.includes("from orders o")) {
          return {
            rows: [
              {
                id: "00000000-0000-4000-8000-000000000010",
                venue: "limitless",
                fee_bps: 0,
                fee_scale: null,
                polymarket_builder_code: null,
                polymarket_builder_taker_fee_bps: null,
                polymarket_builder_maker_fee_bps: null,
                limitless_fee_share_bps: 5_000,
                effective_at: new Date("2026-05-19T00:00:00.000Z"),
                created_at: new Date("2026-05-19T00:00:00.000Z"),
              },
            ],
          };
        }
        return { rows: [] };
      },
    };

    const result = await backfillLimitlessVenueShareAccruals(pool as never, {
      limit: 7,
      minAgeSec: 60,
    });

    assert.deepEqual(result, { checked: 0, upserted: 0, skipped: 0 });
    const candidateQuery = queries.find((query) =>
      query.sql.includes("from orders o"),
    );
    assert.ok(candidateQuery);
    assert.match(candidateQuery.sql, /left join lateral/i);
    assert.match(candidateQuery.sql, /p\.effective_at <= c\.candidate_time/i);
    assert.match(candidateQuery.sql, /venue_fee_backfill_attempts/i);
    assert.match(candidateQuery.sql, /_hunchUpstream/i);
    assert.match(candidateQuery.sql, /o\.order_payload->'submitted'/i);
    assert.equal(candidateQuery.params[1], 7);
    assert.equal(candidateQuery.params[2], 60);
    assert.equal(candidateQuery.params[3], false);
    assert.equal(candidateQuery.params[4], 5_000);
  },
);

await testAsync(
  "backfill still scans historical DB policy windows when latest share is zero",
  async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      async query(sql: string, params: unknown[] = []) {
        queries.push({ sql, params });
        if (sql.includes("from fee_policy") && !sql.includes("from orders o")) {
          return {
            rows: [
              {
                id: "00000000-0000-4000-8000-000000000011",
                venue: "limitless",
                fee_bps: 0,
                fee_scale: null,
                polymarket_builder_code: null,
                polymarket_builder_taker_fee_bps: null,
                polymarket_builder_maker_fee_bps: null,
                limitless_fee_share_bps: 0,
                effective_at: new Date("2026-05-20T00:00:00.000Z"),
                created_at: new Date("2026-05-20T00:00:00.000Z"),
              },
            ],
          };
        }
        return { rows: [] };
      },
    };

    const result = await backfillLimitlessVenueShareAccruals(pool as never, {
      limit: 7,
      minAgeSec: 60,
    });

    assert.deepEqual(result, { checked: 0, upserted: 0, skipped: 0 });
    assert.ok(queries.some((query) => query.sql.includes("from orders o")));
  },
);
