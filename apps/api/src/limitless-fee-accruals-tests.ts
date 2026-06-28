#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { ethers } from "ethers";

import {
  backfillLimitlessVenueShareAccruals,
  buildStoredLimitlessOrderStatusItem,
  buildLimitlessVenueShareAccrualFromReceiptLogs,
  buildLimitlessVenueShareAccrualFromStatus,
  buildLimitlessVenueShareAccrualResult,
  type LimitlessAccrualOrderRow,
  type LimitlessFeeShareConfig,
  type LimitlessOrderStatusItem,
} from "./services/limitless-fee-accruals.js";
import {
  buildLimitlessContractAccrualSourceId,
  buildLimitlessContractFeeSourceId,
  buildLimitlessContractStatusFeeSourceKey,
  convertLimitlessReceivableRaw,
} from "./services/limitless-contract-fee-receivables.js";

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
const receiptConfig: LimitlessFeeShareConfig = {
  ...config,
  shareBps: 5_000,
};
const limitlessOrderFilledInterface = new ethers.Interface([
  "event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)",
]);
const limitlessFeeChargedInterface = new ethers.Interface([
  "event FeeCharged(address indexed receiver, uint256 tokenId, uint256 amount)",
]);
const limitlessFeeRefundedInterface = new ethers.Interface([
  "event FeeRefunded(address token, address to, uint256 id, uint256 amount)",
]);
const limitlessExchange = "0x05c748E2f4DcDe0ec9Fa8DDc40DE6b867f923fa5";
const feeReceiver = "0xF94ef760884b0605E433853Aed17DA574160226E";

function eventLog(
  iface: ethers.Interface,
  eventName: string,
  args: unknown[],
  index: number,
  address = limitlessExchange,
) {
  const event = iface.getEvent(eventName);
  assert.ok(event);
  const encoded = iface.encodeEventLog(event, args);
  return {
    address,
    topics: encoded.topics,
    data: encoded.data,
    index,
  };
}

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

function receiptOrder(
  side: "BUY" | "SELL",
  tokenId = "48772550132642880323939814998924888786090838839401112676991758227761295949349",
): LimitlessAccrualOrderRow {
  return {
    ...baseOrder(),
    wallet_address: "0x17Cac6E4b08C8D95A2890a8DF7Cb0e7d83711387",
    signer_address: "0x17Cac6E4b08C8D95A2890a8DF7Cb0e7d83711387",
    order_hash:
      "0x035c18156176a837f1a728893a3921fe101c7c929cc1d2133ee93ae0326a055d",
    token_id: tokenId,
    side,
  };
}

function statusWithTotals(
  totalsRaw: Record<string, string>,
  options: { side?: 0 | 1; tokenId?: string } = {},
): LimitlessOrderStatusItem {
  return {
    orderId: "limitless-order-1",
    payload: {
      status: "found",
      orderId: "limitless-order-1",
      data: {
        order: {
          order: {
            side: options.side ?? 0,
            tokenId: options.tokenId ?? "456",
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
    status: statusWithTotals(
      {
        usdGross: "1000000",
        usdFee: "10000",
        contractsGross: "2000000",
        contractsFee: "0",
      },
      { side: 1 },
    ),
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

test("converts Limitless receivable raw amount with integer payout ratio", () => {
  assert.equal(convertLimitlessReceivableRaw("1000000", "1", "1"), "1000000");
  assert.equal(convertLimitlessReceivableRaw("1000000", "1", "2"), "500000");
  assert.equal(convertLimitlessReceivableRaw("999999", "0", "1"), "0");
});

test("builds stable source ids for Limitless contract fee accrual unlocks", () => {
  const txHash =
    "0x9c80f1398a443f121407c81d956c35ae385616244399fe04bf3d217e76ae255d";
  assert.equal(
    buildLimitlessContractFeeSourceId({ txHash, logIndex: 276 }),
    `limitless:venue_share_contract:${txHash}:276`,
  );
  assert.equal(
    buildLimitlessContractStatusFeeSourceKey({
      venueOrderId: "limitless-order-1",
      tokenId: "limitless:456",
    }),
    "status:limitless-order-1:limitless:456",
  );
  assert.equal(
    buildLimitlessContractAccrualSourceId({
      venue: "limitless",
      feeProgram: "venue_share_contract",
      orderHash: "order-hash",
      venueFillId: "276",
      txHash,
    }),
    `limitless:venue_share_contract:${txHash}:276`,
  );
  assert.equal(
    buildLimitlessContractAccrualSourceId({
      venue: "limitless",
      feeProgram: "venue_share_contract",
      orderHash: "order-hash",
      venueFillId: "status:limitless-order-1:limitless:456",
      txHash,
    }),
    "limitless:venue_share_contract:order-hash:status:limitless-order-1:limitless:456",
  );
});

test("builds Limitless contract receivable from buy-side contracts fee status", () => {
  const result = buildLimitlessVenueShareAccrualResult({
    order: baseOrder(),
    status: statusWithTotals({
      usdGross: "1000000",
      usdFee: "0",
      contractsGross: "2000000",
      contractsFee: "10000",
    }),
    config,
  });

  assert.equal(result.accrual, null);
  assert.equal(result.attempt, null);
  assert.ok(result.receivable);
  assert.equal(result.receivable.sourceKind, "status");
  assert.equal(result.receivable.sourceKey, undefined);
  assert.equal(
    result.receivable.txHash,
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  assert.equal(result.receivable.logIndex, null);
  assert.equal(result.receivable.rawTokenId, "456");
  assert.equal(result.receivable.tokenId, "limitless:456");
  assert.equal(result.receivable.grossTokenAmountRaw, "10000");
  assert.equal(result.receivable.receivableTokenAmountRaw, "1000");
});

test("does not create Limitless receivable for sell-side contracts fee status", () => {
  const result = buildLimitlessVenueShareAccrualResult({
    order: { ...baseOrder(), side: "SELL" },
    status: statusWithTotals(
      {
        usdGross: "1000000",
        usdFee: "0",
        contractsGross: "2000000",
        contractsFee: "10000",
      },
      { side: 1 },
    ),
    config,
  });

  assert.equal(result.accrual, null);
  assert.equal(result.receivable, null);
  assert.equal(
    result.attempt?.reason,
    "Limitless contracts fee is only expected on buys",
  );
});

test("does not create Limitless accrual when status has both fee denominations", () => {
  const result = buildLimitlessVenueShareAccrualResult({
    order: baseOrder(),
    status: statusWithTotals({
      usdGross: "1000000",
      usdFee: "10000",
      contractsGross: "2000000",
      contractsFee: "10000",
    }),
    config,
  });

  assert.equal(result.accrual, null);
  assert.equal(result.receivable, null);
  assert.equal(
    result.attempt?.reason,
    "Limitless fee totals include both USD and contracts fees",
  );
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

test("builds Limitless accrual from onchain SELL receipt with USDC fee", () => {
  const orderHash =
    "0xa1bde9b22096ae5abc1a85b3cdb94377a2c95394e36e65e2fa551751e10d01f2";
  const tokenId =
    "48772550132642880323939814998924888786090838839401112676991758227761295949349";
  const logs = [
    eventLog(
      limitlessFeeChargedInterface,
      "FeeCharged",
      [feeReceiver, 0n, 8087n],
      1,
    ),
    eventLog(
      limitlessOrderFilledInterface,
      "OrderFilled",
      [
        orderHash,
        "0x17Cac6E4b08C8D95A2890a8DF7Cb0e7d83711387",
        limitlessExchange,
        BigInt(tokenId),
        0n,
        1_010_000n,
        869_610n,
        8087n,
      ],
      2,
    ),
  ];

  const result = buildLimitlessVenueShareAccrualFromReceiptLogs({
    order: receiptOrder("SELL", `limitless:${tokenId}`),
    txHash:
      "0x035c18156176a837f1a728893a3921fe101c7c929cc1d2133ee93ae0326a055d",
    logs,
    config: receiptConfig,
  });

  assert.ok(result.accrual);
  assert.equal(result.accrual.feeAsset, "USDC");
  assert.equal(result.accrual.notionalAmountRaw, "869610");
  assert.equal(result.accrual.venueFeeAmountRaw, "8087");
  assert.equal(result.accrual.feeAmountRaw, "4043");
  assert.equal(result.accrual.venueTradeId, orderHash);
  assert.equal(
    result.accrual.venueFillId,
    "0x035c18156176a837f1a728893a3921fe101c7c929cc1d2133ee93ae0326a055d:2",
  );
});

test("creates Limitless contract receivable when onchain fee is token-denominated", () => {
  const orderHash =
    "0x372e13c3766404a4903af7bb9e702b31cbce8b517e36ee3e474d0756745809e1";
  const tokenId =
    "56174306495450546446617249361431380553366950211553449089489083225409927452816";
  const logs = [
    eventLog(
      limitlessFeeChargedInterface,
      "FeeCharged",
      [feeReceiver, BigInt(tokenId), 10582n],
      1,
    ),
    eventLog(
      limitlessOrderFilledInterface,
      "OrderFilled",
      [
        orderHash,
        "0x17Cac6E4b08C8D95A2890a8DF7Cb0e7d83711387",
        limitlessExchange,
        0n,
        BigInt(tokenId),
        1_000_000n,
        1_189_056n,
        10582n,
      ],
      2,
    ),
  ];

  const result = buildLimitlessVenueShareAccrualFromReceiptLogs({
    order: receiptOrder("BUY", `limitless:${tokenId}`),
    txHash:
      "0x9c80f1398a443f121407c81d956c35ae385616244399fe04bf3d217e76ae255d",
    logs,
    config: receiptConfig,
  });

  assert.equal(result.accrual, null);
  assert.equal(result.attempt, null);
  assert.ok(result.receivable);
  assert.equal(result.receivable.status, "pending_resolution");
  assert.equal(result.receivable.rawTokenId, tokenId);
  assert.equal(result.receivable.tokenId, `limitless:${tokenId}`);
  assert.equal(result.receivable.grossTokenAmountRaw, "10582");
  assert.equal(result.receivable.receivableTokenAmountRaw, "5291");
  assert.equal(result.receivable.feeChargedLogIndex, 1);
  assert.equal(result.receivable.logIndex, 2);
});

test("marks Limitless contract receivable refunded when fee is refunded in same tx", () => {
  const orderHash =
    "0xcf43897839d6e37cc801f26aaf8c3fdb07af7b056a34ee575c4e10cce040ea6d";
  const tokenId =
    "92607358619733740235110107859836604331667007194484796602553714704375329485693";
  const logs = [
    eventLog(
      limitlessFeeChargedInterface,
      "FeeCharged",
      [feeReceiver, BigInt(tokenId), 35671n],
      1,
    ),
    eventLog(
      limitlessOrderFilledInterface,
      "OrderFilled",
      [
        orderHash,
        "0xEbb8612C859e2C468aB3A0c60C59692eC7B51FB0",
        "0x17Cac6E4b08C8D95A2890a8DF7Cb0e7d83711387",
        0n,
        BigInt(tokenId),
        189_060n,
        1_189_056n,
        35671n,
      ],
      2,
    ),
    eventLog(
      limitlessFeeRefundedInterface,
      "FeeRefunded",
      [
        "0xC9c98965297Bc527861c898329Ee280632B76e18",
        "0xEbb8612C859e2C468aB3A0c60C59692eC7B51FB0",
        BigInt(tokenId),
        35671n,
      ],
      3,
      feeReceiver,
    ),
  ];

  const result = buildLimitlessVenueShareAccrualFromReceiptLogs({
    order: receiptOrder("BUY", `limitless:${tokenId}`),
    txHash:
      "0x9c80f1398a443f121407c81d956c35ae385616244399fe04bf3d217e76ae255d",
    logs,
    config: receiptConfig,
  });

  assert.equal(result.accrual, null);
  assert.equal(result.attempt, null);
  assert.ok(result.receivable);
  assert.equal(result.receivable.status, "refunded");
  assert.equal(result.receivable.feeRefundedLogIndex, 3);
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
