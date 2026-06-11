import assert from "node:assert/strict";

import {
  canonicalHyperliquidVenueOrderId,
  extractHyperliquidCancelStatus,
  extractHyperliquidOrderStatus,
  hyperliquidVenueOrderIdAliases,
  normalizeHyperliquidClientOrderId,
  normalizeHyperliquidExchangeOrderId,
  normalizeHyperliquidUserFills,
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
        data: { statuses: [{ filled: { oid: 43, totalSz: "2.5", avgPx: "0.4" } }] },
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

test("normalizes confirmed Hyperliquid user fills", () => {
  assert.deepEqual(
    normalizeHyperliquidUserFills([
      {
        coin: "#2360",
        side: "B",
        px: "0.42",
        sz: "3",
        oid: 12345,
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
        venueOrderId: "oid:12345",
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
          hash: "0xabc",
          tid: 987,
          time: 1_781_131_349_000,
        },
      },
    ],
  );
});
