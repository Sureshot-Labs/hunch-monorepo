import assert from "node:assert/strict";

import {
  extractLimitlessMarketAdapterAddress,
  extractLimitlessMarketExchangeAddress,
  resolveLimitlessMarketAdapter,
} from "./limitless-market-contracts.js";

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

const adapter = "0x6151EF8368b6316c1aa3C68453EF083ad31E712D";
test("the indexer's venueAdapter and upstream venue.adapter resolve identically", () => {
  for (const metadata of [
    { venueAdapter: adapter },
    { venue_adapter: adapter },
    { market: { venue: { adapter } } },
    { adapter },
    { adapterAddress: adapter },
    { adapter_address: adapter },
    { negRiskAdapter: adapter },
    { neg_risk_adapter: adapter },
    { operator: adapter },
    { venue: { operator: adapter } },
  ]) {
    assert.deepEqual(resolveLimitlessMarketAdapter(metadata), {
      status: "resolved",
      address: adapter,
    });
    assert.equal(extractLimitlessMarketAdapterAddress(metadata), adapter);
  }
});

test("market exchange is never substituted for a missing adapter", () => {
  for (const metadata of [
    {},
    null,
    { venue: { exchange: adapter, adapter: null } },
    { venueExchange: adapter, venueAdapter: null },
  ]) {
    assert.deepEqual(resolveLimitlessMarketAdapter(metadata), {
      status: "missing",
      address: null,
    });
  }
});

test("malformed explicit adapter metadata is distinct from an absent adapter", () => {
  for (const value of ["invalid", "0x1234", " ", 42, {}, []]) {
    assert.deepEqual(resolveLimitlessMarketAdapter({ venueAdapter: value }), {
      status: "invalid",
      address: null,
    });
  }
});

test("existing live-market alias precedence is preserved", () => {
  const operator = "0x00000000000000000000000000000000000000A1";
  assert.equal(
    extractLimitlessMarketAdapterAddress({
      operator,
      adapter,
      venueAdapter: adapter,
      venue: { adapter },
    }),
    operator,
  );
});
