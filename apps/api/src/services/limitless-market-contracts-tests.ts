import assert from "node:assert/strict";

import { extractLimitlessMarketExchangeAddress } from "./limitless-market-contracts.js";

function test(name: string, run: () => void): void {
  run();
  console.log(`ok - ${name}`);
}

test("uses the explicit persisted market exchange", () => {
  assert.equal(
    extractLimitlessMarketExchangeAddress({
      venueExchange: "0x00000000000000000000000000000000000000A1",
    }),
    "0x00000000000000000000000000000000000000A1",
  );
});

test("uses the same parser for upstream market payloads", () => {
  assert.equal(
    extractLimitlessMarketExchangeAddress({
      market: {
        venue: {
          exchangeAddress: "0x00000000000000000000000000000000000000b2",
        },
      },
    }),
    "0x00000000000000000000000000000000000000b2",
  );
});

test("never treats malformed metadata as a contract", () => {
  assert.equal(
    extractLimitlessMarketExchangeAddress({ venueExchange: "not-an-address" }),
    null,
  );
});
