#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  buildFundingTradeConsumerIntent,
  compareFundingTradeConsumerIntentToConfirmedBound,
  sameFundingTradeConsumerIntent,
  storedFundingTradeConsumerIntent,
} from "../../persistence/funding-trade-consumer-intent.js";

const asset = {
  networkId: "evm:137",
  assetId: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
  decimals: 6,
};
const exact = buildFundingTradeConsumerIntent({
  venueId: "polymarket",
  marketId: "polymarket:market-1",
  marketContextId: "outcome-token-yes",
  spend: { asset, raw: "4723189" },
});

assert.throws(
  () =>
    buildFundingTradeConsumerIntent({
      venueId: "future-venue",
      marketId: "future-venue:Case:Sensitive/42",
      marketContextId: "future-venue:Outcome:Case",
      spend: exact.spend,
    }),
  /venue-local outcome identifier/,
);

assert.equal(
  sameFundingTradeConsumerIntent(
    exact,
    buildFundingTradeConsumerIntent({
      venueId: "polymarket",
      marketId: "polymarket:market-1",
      marketContextId: "outcome-token-yes",
      spend: {
        asset: { ...asset, assetId: asset.assetId.toLowerCase() },
        raw: "4723189",
      },
    }),
  ),
  true,
);

for (const changed of [
  buildFundingTradeConsumerIntent({
    venueId: "polymarket",
    marketId: "polymarket:market-1",
    marketContextId: "outcome-token-yes",
    spend: { asset, raw: "4723188" },
  }),
  buildFundingTradeConsumerIntent({
    venueId: "polymarket",
    marketId: "polymarket:market-1",
    marketContextId: "outcome-token-no",
    spend: { asset, raw: "4723189" },
  }),
  buildFundingTradeConsumerIntent({
    venueId: "polymarket",
    marketId: "polymarket:market-1",
    marketContextId: "outcome-token-yes",
    spend: {
      asset: {
        ...asset,
        assetId: "0x0000000000000000000000000000000000000001",
      },
      raw: "4723189",
    },
  }),
  buildFundingTradeConsumerIntent({
    venueId: "polymarket",
    marketId: "polymarket:market-1",
    marketContextId: "outcome-token-yes",
    spend: { asset: { ...asset, decimals: 18 }, raw: "4723189" },
  }),
]) {
  assert.equal(sameFundingTradeConsumerIntent(exact, changed), false);
}

const feeInclusivePolymarketBound = buildFundingTradeConsumerIntent({
  venueId: "polymarket",
  marketId: "polymarket:market-1",
  marketContextId: "outcome-token-yes",
  spend: { asset, raw: "5172501" },
});
const lowerFeeInclusivePolymarketSpend = buildFundingTradeConsumerIntent({
  venueId: "polymarket",
  marketId: "polymarket:market-1",
  marketContextId: "outcome-token-yes",
  spend: { asset, raw: "5100000" },
});
assert.equal(
  compareFundingTradeConsumerIntentToConfirmedBound(
    feeInclusivePolymarketBound,
    lowerFeeInclusivePolymarketSpend,
  ),
  "matched",
  "a fresh fee-inclusive spend may be lower than its confirmed funding bound",
);
const excessiveFeeInclusivePolymarketSpend = buildFundingTradeConsumerIntent({
  venueId: "polymarket",
  marketId: "polymarket:market-1",
  marketContextId: "outcome-token-yes",
  spend: { asset, raw: "5172502" },
});
assert.equal(
  compareFundingTradeConsumerIntentToConfirmedBound(
    feeInclusivePolymarketBound,
    excessiveFeeInclusivePolymarketSpend,
  ),
  "spend_exceeded",
  "the fresh fee-inclusive spend may never exceed the confirmed funding bound",
);
assert.equal(
  compareFundingTradeConsumerIntentToConfirmedBound(
    feeInclusivePolymarketBound,
    buildFundingTradeConsumerIntent({
      venueId: "polymarket",
      marketId: "polymarket:market-1",
      marketContextId: "outcome-token-no",
      spend: { asset, raw: "5000000" },
    }),
  ),
  "scope_mismatch",
  "a lower spend cannot widen the funded market/outcome scope",
);

assert.throws(
  () =>
    buildFundingTradeConsumerIntent({
      venueId: "polymarket",
      marketId: "market-1",
      marketContextId: "outcome-token-yes",
      spend: { asset, raw: "4723189" },
    }),
  /canonical unified market ID/,
);

assert.deepEqual(
  storedFundingTradeConsumerIntent({
    operationVenueId: "polymarket",
    operationMarketId: "polymarket:market-1",
    marketContextSnapshot: {
      venueId: "polymarket",
      marketId: "polymarket:market-1",
      marketContextId: "outcome-token-yes",
      side: "NO",
      collateralAsset: asset,
      requestedCollateralRaw: "4723189",
    },
    requestedDestinationAmount: {
      asset,
      raw: "3749387",
    },
    reservationAsset: asset,
    // The reservation covers the funded shortfall. Existing venue balance
    // covers the remainder of the exact normalized order spend.
    reservationRawAmount: "4000000",
  }),
  exact,
);

console.log(
  "[funding-trade-consumer-intent-tests] consumer scope stays exact while fresh fee-inclusive spend may remain within its confirmed bound",
);
