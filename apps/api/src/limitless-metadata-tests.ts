import assert from "node:assert/strict";

import { extractLimitlessMetadata } from "./lib/limitless-metadata.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("Limitless market metadata takes precedence over event metadata", () => {
  assert.deepEqual(
    extractLimitlessMetadata(
      {
        address: "0xmarket",
        negRiskMarketId: "market-group",
        negRiskRequestId: "market-request",
        tradeType: "amm",
        venueAdapter: "market-adapter",
        venueExchange: "market-exchange",
      },
      {
        address: "0xevent",
        negRiskMarketId: "event-group",
        negRiskRequestId: "event-request",
        tradeType: "clob",
        venueAdapter: "event-adapter",
        venueExchange: "event-exchange",
      },
    ),
    {
      marketAddress: "0xmarket",
      negRiskMarketId: "market-group",
      negRiskRequestId: "market-request",
      tradeType: "amm",
      venueAdapter: "market-adapter",
      venueExchange: "market-exchange",
    },
  );
});

test("Limitless group fields fall back to event metadata", () => {
  assert.deepEqual(
    extractLimitlessMetadata(
      {},
      {
        negRiskMarketId: "event-group",
        venueAdapter: "event-adapter",
        exchangeAddress: "event-exchange",
      },
    ),
    {
      marketAddress: undefined,
      negRiskMarketId: "event-group",
      negRiskRequestId: undefined,
      tradeType: undefined,
      venueAdapter: "event-adapter",
      venueExchange: "event-exchange",
    },
  );
});

test("Limitless market-specific fields never inherit from event metadata", () => {
  const metadata = extractLimitlessMetadata(null, {
    address: "0xevent",
    negRiskRequestId: "event-request",
    tradeType: "amm",
  });

  assert.equal(metadata.marketAddress, undefined);
  assert.equal(metadata.negRiskRequestId, undefined);
  assert.equal(metadata.tradeType, undefined);
});

test("Limitless exchange supports nested venue fallbacks", () => {
  assert.equal(
    extractLimitlessMetadata(
      { venue: { exchangeAddress: "nested-market-exchange" } },
      { venueExchange: "event-exchange" },
    ).venueExchange,
    "nested-market-exchange",
  );
  assert.equal(
    extractLimitlessMetadata(null, {
      venue: { exchange: "nested-event-exchange" },
    }).venueExchange,
    "nested-event-exchange",
  );
});

test("Limitless metadata ignores blank and malformed values", () => {
  assert.deepEqual(extractLimitlessMetadata("not-json", { venue: [] }), {
    marketAddress: undefined,
    negRiskMarketId: undefined,
    negRiskRequestId: undefined,
    tradeType: undefined,
    venueAdapter: undefined,
    venueExchange: undefined,
  });
  assert.equal(
    extractLimitlessMetadata(
      { venueExchange: "   " },
      { negRiskExchange: "event-exchange" },
    ).venueExchange,
    "event-exchange",
  );
});
