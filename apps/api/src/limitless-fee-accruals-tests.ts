#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { ethers } from "ethers";
import { env } from "./env.js";

import {
  backfillLimitlessVenueShareAccruals,
  buildStoredLimitlessOrderStatusItem,
  buildLimitlessVenueShareAccrualFromReceiptLogs,
  buildLimitlessVenueShareAccrualFromStatus,
  buildLimitlessVenueShareAccrualResult,
  extractTxHashFromLimitlessStatus,
  fetchLimitlessAccrualOrderStatuses,
  resolveLimitlessCollateralAccrual,
  type LimitlessAccrualOrderRow,
  type LimitlessFeeShareConfig,
  type LimitlessOrderStatusItem,
} from "./services/limitless-fee-accruals.js";
import { feeEventSourceIdForAccrual } from "./services/venue-fee-accruals.js";
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

await testAsync(
  "Limitless fee status lanes retain distinct locators and tolerate one failed lookup",
  async () => {
    const providerTx = `0x${"a".repeat(64)}`;
    const clientTx = `0x${"b".repeat(64)}`;
    const byOrder = {
      orderId: "venue-1",
      payload: { execution: { txHash: providerTx } },
    };
    const byClient = {
      orderId: "venue-1",
      payload: { execution: { txHash: clientTx } },
    };
    const lookup = [{ orderId: "venue-1", clientOrderId: "hunch-1" }];
    const both = await fetchLimitlessAccrualOrderStatuses(
      lookup,
      async (keys) =>
        keys[0]?.orderId
          ? new Map([
              ["venue-1", byOrder],
              ["client:hunch-1", byOrder],
            ])
          : new Map([
              ["venue-1", byClient],
              ["client:hunch-1", byClient],
            ]),
    );
    assert.equal(both.unavailable, false);
    assert.equal(both.statuses.get("venue-1"), byOrder);
    assert.equal(both.statuses.get("client:hunch-1"), byClient);
    const one = await fetchLimitlessAccrualOrderStatuses(
      lookup,
      async (keys) => {
        if (keys[0]?.orderId) throw new Error("venue unavailable");
        return new Map([["client:hunch-1", byClient]]);
      },
    );
    assert.equal(one.unavailable, true);
    assert.equal(one.statuses.get("client:hunch-1"), byClient);
    for (const field of ["txHash", "transactionHash", "tx_hash"]) {
      assert.equal(
        extractTxHashFromLimitlessStatus({
          orderId: "venue-1",
          payload: { data: { order: { execution: { [field]: clientTx } } } },
        }),
        clientTx,
      );
    }
  },
);

test("COLLATERAL status neither creates provisional accruals nor falls back without provenance", () => {
  for (const side of [0, 1] as const) {
    const status = statusWithTotals(
      { usdGross: "1000000", usdFee: "10000", contractsFee: "0" },
      { side, tokenId: "123" },
    );
    const data = status.payload.data as { execution: { feeRateBps: number } };
    data.execution.feeRateBps = 0;
    const result = buildLimitlessVenueShareAccrualResult({
      order: {
        ...baseOrder(),
        side: side === 0 ? "BUY" : "SELL",
        order_payload: {
          _hunchLimitlessClob: { collateralFeeModule: feeReceiver },
        },
      },
      status,
      config,
    });
    assert.equal(result.accrual, null);
    assert.equal(
      result.attempt?.reason,
      "Limitless collateral fee requires a finalized receipt",
    );
    const old = buildLimitlessVenueShareAccrualResult({
      order: baseOrder(),
      status,
      config,
    });
    assert.equal(old.accrual, null);
    assert.equal(
      old.attempt?.reason,
      "Limitless collateral fee provenance missing",
    );
  }
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

await testAsync(
  "COLLATERAL BUY and SELL require the canonical finalized receipt and exact USDC debit",
  async () => {
    const payer = baseOrder().wallet_address;
    assert.ok(payer);
    const feeModule = "0x7B6ffe5bA8B5ec7afB0AaBaE629D12dA5bC62565";
    const orderHash = `0x${"22".repeat(32)}`;
    const txHash = `0x${"11".repeat(32)}`;
    const tokenId = 123n;
    const fee = 4700n;
    const transferInterface = new ethers.Interface([
      "event Transfer(address indexed from, address indexed to, uint256 value)",
    ]);
    const order: LimitlessAccrualOrderRow = {
      ...baseOrder(),
      order_type: "FOK",
      order_payload: {
        _hunchLimitlessClob: {
          contextVersion: 1,
          chainId: 8453,
          exchangeAddress: limitlessExchange,
          orderHash,
          collateralFeeModule: feeModule,
        },
      },
    };
    const fill = eventLog(
      limitlessOrderFilledInterface,
      "OrderFilled",
      [
        orderHash,
        payer,
        limitlessExchange,
        0n,
        tokenId,
        2_000_000n,
        2_098_617n,
        0n,
      ],
      16,
    );
    const transfer = eventLog(
      transferInterface,
      "Transfer",
      [payer, feeReceiver, fee],
      18,
      env.limitlessUsdcAddress,
    );
    const chargeData = (values: readonly unknown[]) =>
      ethers.AbiCoder.defaultAbiCoder().encode(
        [
          "uint256",
          "uint256",
          "uint256",
          "uint256",
          "uint256",
          "uint256",
          "address",
          "address",
        ],
        values,
      );
    const charge = {
      address: feeModule,
      topics: [
        "0x363a587c4640b524767666acd46b6600a7308a3692b1c11c2f5a930318e04866",
        orderHash,
        ethers.zeroPadValue(payer, 32),
        ethers.toBeHex(tokenId, 32),
      ],
      data: chargeData([
        0n,
        2_000_000n,
        1_999_982n,
        2_098_617n,
        fee,
        1000n,
        feeReceiver,
        ethers.ZeroAddress,
      ]),
      index: 19,
    };
    const build = (logs: (typeof fill)[], side: "BUY" | "SELL" = "BUY") =>
      buildLimitlessVenueShareAccrualFromReceiptLogs({
        order: { ...order, side },
        txHash,
        logs,
        config: receiptConfig,
      });
    const result = build([fill, transfer, charge]);
    assert.equal(result.accrual?.venueFeeAmountRaw, "4700");
    assert.equal(result.accrual?.feeAmountRaw, "2350");
    assert.equal(result.accrual?.venueFeeRateBps, 0);
    assert.equal(result.accrual?.notionalAmountRaw, "1999982");
    assert.equal(result.accrual?.venueFillId, `collateral:${txHash}:19`);
    assert.equal(result.accrual?.orderHash, orderHash);
    assert.equal(result.receivable, null);
    const status = statusWithTotals(
      { usdGross: "1999982", usdFee: "4700", contractsFee: "0" },
      { tokenId: "123" },
    );
    const data = status.payload.data as { execution: { txHash: string } };
    data.execution.txHash = txHash;
    assert.equal(
      buildLimitlessVenueShareAccrualFromStatus({ order, status, config }),
      null,
    );
    const debitId = {
      venue: "limitless",
      fee_program: "venue_share",
      chain_id: "8453",
      tx_hash: txHash,
      venue_fill_id: `collateral:${txHash}:19`,
    };
    assert.equal(
      feeEventSourceIdForAccrual({ ...debitId, order_hash: "alias-a" }),
      feeEventSourceIdForAccrual({ ...debitId, order_hash: "alias-b" }),
    );
    const gtc = buildLimitlessVenueShareAccrualFromReceiptLogs({
      order: { ...order, order_type: "GTC" },
      txHash,
      logs: [fill, transfer, charge],
      config,
    });
    assert.equal(gtc.accrual, null);
    assert.equal(
      gtc.attempt?.reason,
      "Limitless collateral GTC fee reconciliation unsupported",
    );
    const hashOf = (byte: string) => `0x${byte.repeat(32)}`;
    const staleTx = hashOf("33");
    const orphanTx = hashOf("44");
    const tooNewTx = hashOf("55");
    const blockHash = hashOf("66");
    const receipts: string[] = [];
    const provider = {
      async getTransactionReceipt(hash: string) {
        receipts.push(hash);
        return {
          hash: hash === staleTx ? txHash : hash,
          status: 1,
          blockNumber: hash === tooNewTx ? 20 : 10,
          blockHash: hash === orphanTx ? hashOf("77") : blockHash,
          logs: [fill, transfer, charge],
        };
      },
      async getBlock(block: number | "finalized") {
        return {
          hash: blockHash,
          number: block === "finalized" ? 14 : block,
          timestamp: 100,
        };
      },
    };
    const checked = new Set<string>();
    const pending = await resolveLimitlessCollateralAccrual({
      order,
      config,
      provider,
      locators: [staleTx, orphanTx, tooNewTx],
      checked,
    });
    assert.equal(pending.accrual, null);
    assert.equal(pending.attempt?.retryable, true);
    const resolved = await resolveLimitlessCollateralAccrual({
      order,
      config,
      provider,
      locators: [staleTx, txHash],
      checked,
      shareAt: async (settledAt) => {
        assert.equal(settledAt.toISOString(), "1970-01-01T00:01:40.000Z");
        return 2500;
      },
    });
    assert.equal(resolved.accrual?.venueFeeAmountRaw, "4700");
    assert.equal(resolved.accrual?.feeAmountRaw, "1175");
    assert.equal(resolved.accrual?.feeRateBps, 2500);
    assert.deepEqual(receipts, [staleTx, orphanTx, tooNewTx, txHash]);
    const unattempted = new Set<string>();
    const deferred = await resolveLimitlessCollateralAccrual({
      order,
      config,
      provider,
      locators: [txHash],
      checked: unattempted,
      withinBudget: () => false,
    });
    assert.equal(
      deferred.attempt?.reason,
      "Limitless collateral fee RPC budget exhausted",
    );
    assert.equal(unattempted.size, 0);
    let admissionChecks = 0;
    const interrupted = await resolveLimitlessCollateralAccrual({
      order,
      config,
      provider,
      locators: [txHash],
      checked: unattempted,
      withinBudget: () => admissionChecks++ === 0,
    });
    assert.equal(
      interrupted.attempt?.reason,
      "Limitless collateral fee RPC budget exhausted",
    );
    assert.equal(
      unattempted.size,
      0,
      "an interrupted receipt is still eligible in the fresh lane",
    );
    const resumed = await resolveLimitlessCollateralAccrual({
      order,
      config,
      provider,
      locators: [txHash],
      checked: unattempted,
    });
    assert.equal(resumed.accrual?.venueFeeAmountRaw, "4700");
    const historyOnly = buildLimitlessVenueShareAccrualFromReceiptLogs({
      order: { ...order, order_payload: null },
      txHash,
      logs: [fill, transfer, charge],
      config: receiptConfig,
    });
    assert.equal(historyOnly.accrual, null);
    assert.equal(
      historyOnly.attempt?.reason,
      "Limitless collateral fee provenance missing",
    );
    // Base SELL 0xf3c4ef69e4954e4f957c1cb30a857e5de6d76bc18e6f92ba541a634556b98aa8:
    // the maker amount is outcome shares, not the USDC proceeds.
    const sellFee = 61_590n;
    const sellFill = eventLog(
      limitlessOrderFilledInterface,
      "OrderFilled",
      [
        orderHash,
        payer,
        limitlessExchange,
        tokenId,
        0n,
        5_070_000n,
        2_109_120n,
        0n,
      ],
      83,
    );
    const sellTransfer = eventLog(
      transferInterface,
      "Transfer",
      [payer, feeReceiver, sellFee],
      85,
      env.limitlessUsdcAddress,
    );
    const sellCharge = {
      ...charge,
      index: 86,
      data: chargeData([
        1n,
        5_070_000n,
        2_109_120n,
        5_070_000n,
        sellFee,
        1000n,
        feeReceiver,
        ethers.ZeroAddress,
      ]),
    };
    const sell = build([sellFill, sellTransfer, sellCharge], "SELL");
    assert.equal(sell.accrual?.venueFeeAmountRaw, "61590");
    assert.equal(sell.accrual?.notionalAmountRaw, "2109120");
    assert.equal(sell.accrual?.feeAmountRaw, "30795");
    assert.equal(sell.accrual?.side, "SELL");
    for (const logs of [
      [fill, charge],
      [fill, { ...transfer, address: limitlessExchange }, charge],
      [fill, transfer, { ...charge, address: limitlessExchange }],
      [
        fill,
        transfer,
        {
          ...charge,
          topics: [charge.topics[0], txHash, ...charge.topics.slice(2)],
        },
      ],
      [
        fill,
        transfer,
        {
          ...charge,
          topics: [...charge.topics.slice(0, 3), ethers.toBeHex(456, 32)],
        },
      ],
      [
        fill,
        transfer,
        charge,
        { ...transfer, index: 20 },
        { ...charge, index: 21 },
      ],
      [fill, transfer, charge, { ...charge, data: "0x", index: 20 }],
      [fill, { ...fill, index: 17 }, transfer, charge],
      [
        fill,
        { ...transfer, data: `${transfer.data}${"00".repeat(32)}` },
        charge,
      ],
      [fill, { ...transfer, topics: [...transfer.topics, txHash] }, charge],
      [
        fill,
        eventLog(
          transferInterface,
          "Transfer",
          [payer, payer, fee],
          18,
          env.limitlessUsdcAddress,
        ),
        {
          ...charge,
          data: chargeData([
            0n,
            2_000_000n,
            1_999_982n,
            2_098_617n,
            fee,
            1000n,
            payer,
            ethers.ZeroAddress,
          ]),
        },
      ],
    ]) {
      const invalid = build(logs);
      assert.equal(invalid.accrual, null);
      assert.equal(invalid.receivable, null);
      assert.equal(invalid.attempt?.retryable, true);
    }
  },
);

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
        if (
          sql.includes("from fee_policy") &&
          !sql.includes("from orders terminal_order")
        ) {
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
      query.sql.includes("from orders terminal_order"),
    );
    assert.ok(candidateQuery);
    assert.match(candidateQuery.sql, /left join lateral/i);
    assert.match(candidateQuery.sql, /p\.effective_at <= c\.candidate_time/i);
    assert.match(candidateQuery.sql, /venue_fee_backfill_attempts/i);
    assert.match(candidateQuery.sql, /_hunchUpstream/i);
    assert.match(candidateQuery.sql, /admitted\.lane_position/i);
    assert.match(candidateQuery.sql, /coalesce\(b\.next_attempt_at,/i);
    assert.doesNotMatch(
      candidateQuery.sql,
      /o\.order_payload\s*\?\s*'_hunchUpstream'/i,
    );
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
        if (
          sql.includes("from fee_policy") &&
          !sql.includes("from orders terminal_order")
        ) {
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
    assert.ok(
      queries.some((query) => query.sql.includes("from orders terminal_order")),
    );
  },
);
