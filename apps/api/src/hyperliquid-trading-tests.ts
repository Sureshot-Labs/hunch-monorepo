import assert from "node:assert/strict";

import {
  buildHyperliquidOrderAction,
  buildHyperliquidUsdClassTransferAction,
  buildHyperliquidWithdrawAction,
  canonicalHyperliquidVenueOrderId,
  extractHyperliquidCancelStatus,
  extractHyperliquidOrderStatus,
  hyperliquidOutcomeOrderPrecision,
  hyperliquidVenueOrderIdAliases,
  isHyperliquidSizeAligned,
  normalizeHyperliquidClientOrderId,
  normalizeHyperliquidExchangeOrderId,
  normalizeHyperliquidUserFills,
  roundHyperliquidSizeToLot,
} from "./services/hyperliquid-trading.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("normalizes Hyperliquid cloid and oid values", () => {
  assert.equal(
    normalizeHyperliquidClientOrderId(
      "cloid:0xABCDEFabcdefABCDEFabcdefABCDEFab",
    ),
    "0xabcdefabcdefabcdefabcdefabcdefab",
  );
  assert.equal(normalizeHyperliquidClientOrderId("0xnot-valid"), null);
  assert.equal(normalizeHyperliquidExchangeOrderId("oid:12345"), "12345");
  assert.equal(normalizeHyperliquidExchangeOrderId(12345), "12345");
  assert.equal(normalizeHyperliquidExchangeOrderId("0"), null);
});

test("builds canonical Hyperliquid venue order ids and aliases", () => {
  const cloid = "0xabcdefabcdefabcdefabcdefabcdefab";
  assert.equal(
    canonicalHyperliquidVenueOrderId({ cloid: `cloid:${cloid}` }),
    `cloid:${cloid}`,
  );
  assert.equal(
    canonicalHyperliquidVenueOrderId({ oid: "oid:12345" }),
    "oid:12345",
  );
  assert.deepEqual(
    hyperliquidVenueOrderIdAliases({
      cloid,
      oid: "12345",
      venueOrderId: `cloid:${cloid}`,
    }),
    [`cloid:${cloid}`, cloid, "oid:12345", "12345"],
  );
});

test("extracts resting and filled Hyperliquid order acknowledgements", () => {
  assert.deepEqual(
    extractHyperliquidOrderStatus({
      status: "ok",
      response: { data: { statuses: [{ resting: { oid: 42 } }] } },
    }),
    {
      status: "live",
      venueOrderId: "42",
      errorMessage: null,
      filledSize: null,
      averageFillPrice: null,
    },
  );
  assert.deepEqual(
    extractHyperliquidOrderStatus({
      status: "ok",
      response: {
        data: {
          statuses: [{ filled: { oid: 43, totalSz: "2.5", avgPx: "0.4" } }],
        },
      },
    }),
    {
      status: "filled",
      venueOrderId: "43",
      errorMessage: null,
      filledSize: 2.5,
      averageFillPrice: 0.4,
    },
  );
});

test("extracts rejected order and cancel responses", () => {
  assert.deepEqual(
    extractHyperliquidOrderStatus({
      status: "ok",
      response: { data: { statuses: [{ error: "Insufficient balance" }] } },
    }),
    {
      status: "rejected",
      venueOrderId: null,
      errorMessage: "Insufficient balance",
      filledSize: null,
      averageFillPrice: null,
    },
  );
  assert.deepEqual(
    extractHyperliquidCancelStatus({
      status: "ok",
      response: { data: { statuses: [{ error: "Order was never placed" }] } },
    }),
    { status: "rejected", errorMessage: "Order was never placed" },
  );
  assert.deepEqual(
    extractHyperliquidCancelStatus({
      status: "ok",
      response: { data: { statuses: [{ status: "success" }] } },
    }),
    { status: "cancelled", errorMessage: null },
  );
});

test("formats Hyperliquid outcome orders with whole-share lot sizing", () => {
  const precision = hyperliquidOutcomeOrderPrecision(0);
  assert.deepEqual(precision, { sizeDecimals: 0, priceMaxDecimals: 8 });
  assert.equal(roundHyperliquidSizeToLot(10.18469434, 0, "floor"), 10);
  assert.equal(roundHyperliquidSizeToLot(10.18469434, 0, "ceil"), 11);
  assert.equal(isHyperliquidSizeAligned(10.18469434, 0), false);
  assert.equal(isHyperliquidSizeAligned(10, 0), true);

  const action = buildHyperliquidOrderAction({
    assetId: 100002630,
    side: "BUY",
    price: 0.98187,
    size: 10,
    tif: "Ioc",
    precision,
  });

  assert.equal(action.orders[0]?.p, "0.98187");
  assert.equal(action.orders[0]?.s, "10");
});

test("formats Hyperliquid outcome prices with spot decimal cap from size decimals", () => {
  const precision = hyperliquidOutcomeOrderPrecision(2);
  assert.deepEqual(precision, { sizeDecimals: 2, priceMaxDecimals: 6 });

  const action = buildHyperliquidOrderAction({
    assetId: 100002630,
    side: "SELL",
    price: 0.123456789,
    size: 10.18,
    tif: "Gtc",
    precision,
  });

  assert.equal(action.orders[0]?.p, "0.12346");
  assert.equal(action.orders[0]?.s, "10.18");
});

test("normalizes confirmed Hyperliquid user fills", () => {
  assert.deepEqual(
    normalizeHyperliquidUserFills([
      {
        coin: "#2360",
        side: "B",
        px: "0.42",
        sz: "3",
        oid: 12345,
        cloid: "0x11111111111111111111111111111111",
        hash: "0xabc",
        tid: 987,
        time: 1_781_131_349_000,
      },
      {
        coin: "#2361",
        side: "A",
        px: "0.2",
        sz: "5",
      },
    ]),
    [
      {
        txSignature: "hyperliquid-fill:0xabc",
        quoteId: "987",
        venueOrderId: "cloid:0x11111111111111111111111111111111",
        tokenId: "hyperliquid:100002360",
        side: "BUY",
        price: 0.42,
        size: 3,
        notionalUsd: 1.26,
        executedAt: new Date(1_781_131_349_000),
        raw: {
          coin: "#2360",
          side: "B",
          px: "0.42",
          sz: "3",
          oid: 12345,
          cloid: "0x11111111111111111111111111111111",
          hash: "0xabc",
          tid: 987,
          time: 1_781_131_349_000,
        },
      },
    ],
  );
});

test("builds Hyperliquid withdraw3 user-signed typed data", () => {
  const prepared = buildHyperliquidWithdrawAction({
    amount: "5.500000",
    destination: "0x17cac6e4b08c8d95a2890a8df7cb0e7d83711387",
    time: 1_781_131_349_000,
    isMainnet: true,
  });

  assert.equal(prepared.action.type, "withdraw3");
  assert.equal(prepared.action.amount, "5.5");
  assert.equal(prepared.action.hyperliquidChain, "Mainnet");
  assert.equal(
    prepared.typedData.primaryType,
    "HyperliquidTransaction:Withdraw",
  );
  assert.equal(prepared.typedData.domain.name, "HyperliquidSignTransaction");
  assert.deepEqual(
    prepared.typedData.types["HyperliquidTransaction:Withdraw"],
    [
      { name: "hyperliquidChain", type: "string" },
      { name: "destination", type: "string" },
      { name: "amount", type: "string" },
      { name: "time", type: "uint64" },
    ],
  );
});

test("builds Hyperliquid USDC class transfer typed data", () => {
  const prepared = buildHyperliquidUsdClassTransferAction({
    amount: "10.000000",
    toPerp: false,
    nonce: 1_781_131_349_001,
    isMainnet: true,
  });

  assert.equal(prepared.action.type, "usdClassTransfer");
  assert.equal(prepared.action.amount, "10");
  assert.equal(prepared.action.toPerp, false);
  assert.equal(prepared.action.hyperliquidChain, "Mainnet");
  assert.equal(
    prepared.typedData.primaryType,
    "HyperliquidTransaction:UsdClassTransfer",
  );
  assert.deepEqual(
    prepared.typedData.types["HyperliquidTransaction:UsdClassTransfer"],
    [
      { name: "hyperliquidChain", type: "string" },
      { name: "amount", type: "string" },
      { name: "toPerp", type: "bool" },
      { name: "nonce", type: "uint64" },
    ],
  );
});
