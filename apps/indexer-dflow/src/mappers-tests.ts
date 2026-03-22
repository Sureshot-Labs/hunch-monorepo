import assert from "node:assert/strict";

import {
  mapToUnifiedEvent,
  mapToUnifiedMarket,
  resolveDflowEventCategory,
  resolveDflowMarketCategory,
} from "./mappers.js";
import { applyKalshiPublicEventToMappedMarkets } from "./kalshiPublicEnrichment.js";
import type { KalshiPublicEventData } from "./kalshiPublicClient.js";
import type { DflowSeriesInfo } from "./seriesClient.js";
import type { TDflowEvent, TDflowMarket } from "./types.js";

const DEFAULT_USDC_MINT = "usdc-test-mint";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function makeEvent(
  overrides: Partial<TDflowEvent> & Record<string, unknown> = {},
): TDflowEvent {
  return {
    event_ticker: "KXTESTEVENT",
    title: "Test event",
    category: null,
    markets: [],
    ...overrides,
  } as TDflowEvent;
}

function makeMarket(
  overrides: Partial<TDflowMarket> & Record<string, unknown> = {},
): TDflowMarket {
  return {
    ticker: "KXTESTMARKET",
    title: "Test market",
    status: "active",
    accounts: {
      [DEFAULT_USDC_MINT]: {
        isInitialized: true,
        yesMint: "yes-test-mint",
        noMint: "no-test-mint",
      },
    },
    ...overrides,
  } as TDflowMarket;
}

test("resolveDflowEventCategory maps climate and weather to weather", () => {
  assert.equal(
    resolveDflowEventCategory({ seriesCategory: "Climate and Weather" }),
    "weather",
  );
});

test("resolveDflowEventCategory maps financials to economics", () => {
  assert.equal(
    resolveDflowEventCategory({ eventCategory: "Financials" }),
    "economics",
  );
});

test("resolveDflowEventCategory maps science and technology to technology", () => {
  assert.equal(
    resolveDflowEventCategory({ seriesCategory: "Science and Technology" }),
    "technology",
  );
});

test("resolveDflowEventCategory maps companies to economics", () => {
  assert.equal(
    resolveDflowEventCategory({ seriesCategory: "Companies" }),
    "economics",
  );
});

test("resolveDflowEventCategory maps elections to politics", () => {
  assert.equal(
    resolveDflowEventCategory({ eventCategory: "Elections" }),
    "politics",
  );
});

test("resolveDflowEventCategory maps mentions to mentions", () => {
  assert.equal(
    resolveDflowEventCategory({ seriesCategory: "Mentions" }),
    "mentions",
  );
});

test("resolveDflowEventCategory maps social to other", () => {
  assert.equal(resolveDflowEventCategory({ eventCategory: "Social" }), "other");
});

test("mapToUnifiedEvent matches the shared event resolver", () => {
  const seriesLookup = new Map<string, DflowSeriesInfo>([
    [
      "KXTESTSERIES",
      {
        category: "Science and Technology",
        tags: ["Unmapped Structured Tag"],
        title: "Test series",
      },
    ],
  ]);
  const event = makeEvent({
    category: null,
    series_ticker: "KXTESTSERIES",
    title: "Will a major AI model launch this quarter?",
  });

  const mapped = mapToUnifiedEvent(event, seriesLookup);
  assert.ok(mapped);
  assert.equal(mapped?.category, "technology");
  assert.equal(
    mapped?.category,
    resolveDflowEventCategory({
      eventCategory: event.category,
      seriesCategory: "Science and Technology",
      seriesTags: ["Unmapped Structured Tag"],
    }),
  );
});

test("resolveDflowMarketCategory lets market inherit normalized event category", () => {
  assert.equal(
    resolveDflowMarketCategory({
      marketCategory: null,
      eventCategory: "Climate and Weather",
    }),
    "weather",
  );
});

test("mapToUnifiedMarket inherits normalized event category when market category is missing", () => {
  const market = makeMarket({
    category: null,
    title: "Miami high temperature bracket",
  });

  const mapped = mapToUnifiedMarket(
    market,
    "kalshi:KXHIGHMIA-26FEB10",
    "Miami high temperature",
    "Climate and Weather",
    DEFAULT_USDC_MINT,
    false,
  );

  assert.ok(mapped);
  assert.equal(mapped?.marketRow.category, "weather");
  assert.equal(
    mapped?.marketRow.category,
    resolveDflowMarketCategory({
      marketCategory: null,
      eventCategory: "Climate and Weather",
    }),
  );
});

test("Kalshi public enrichment fills non-price metrics and preserves DFlow price fields", () => {
  const mapped = mapToUnifiedMarket(
    makeMarket({
      ticker: "KXNBA-26-BOS",
      yesBid: 0.13,
      yesAsk: 0.14,
      volume: 100,
      volume24h: 10,
      openInterest: 50,
      liquidity: null,
    }),
    "kalshi:KXNBA-26",
    "Pro Basketball Champion?",
    "sports",
    DEFAULT_USDC_MINT,
    false,
  );

  assert.ok(mapped);

  const publicEvent: KalshiPublicEventData = {
    eventTicker: "KXNBA-26",
    marketsByTicker: new Map([
      [
        "KXNBA-26-BOS",
        {
          ticker: "KXNBA-26-BOS",
          bestBid: 0.13,
          bestAsk: 0.14,
          noBid: 0.86,
          noAsk: 0.87,
          lastPrice: 0.14,
          volumeTotal: 3178016,
          volume24h: 54591,
          openInterest: 2251221,
          liquidity: 0,
        },
      ],
    ]),
  };

  const enriched = applyKalshiPublicEventToMappedMarkets([mapped], publicEvent);
  const first = enriched.mappedMarkets[0];
  assert.ok(first);
  assert.equal(enriched.matchedMarkets, 1);
  assert.equal(enriched.updatedMarkets, 1);
  assert.equal(first.marketRow.best_bid, 0.13);
  assert.equal(first.marketRow.best_ask, 0.14);
  assert.equal(first.marketRow.last_price, 0.135);
  assert.equal(first.marketRow.volume_total, 3178016);
  assert.equal(first.marketRow.volume_24h, 54591);
  assert.equal(first.marketRow.open_interest, 2251221);
  assert.equal(first.marketRow.liquidity, 0);
  assert.equal(first.snapshot?.yesBid, 0.13);
  assert.equal(first.snapshot?.yesAsk, 0.14);
  assert.equal(first.snapshot?.noBid, 0.86);
  assert.equal(first.snapshot?.noAsk, 0.87);
  assert.equal(first.snapshot?.volumeTotal, 3178016);
  assert.equal(first.snapshot?.volume24h, 54591);
  assert.equal(first.snapshot?.openInterest, 2251221);
  assert.equal(first.snapshot?.liquidity, 0);
  assert.equal(enriched.filledBestBid, 0);
  assert.equal(enriched.filledBestAsk, 0);
  assert.equal(enriched.filledLastPrice, 0);
});

test("Kalshi public enrichment fills missing DFlow price fields from public Kalshi", () => {
  const mapped = mapToUnifiedMarket(
    makeMarket({
      ticker: "KXNBA-26-NOP",
      yesBid: null,
      yesAsk: 0.01,
    }),
    "kalshi:KXNBA-26",
    "Pro Basketball Champion?",
    "sports",
    DEFAULT_USDC_MINT,
    false,
  );

  assert.ok(mapped);

  const publicEvent: KalshiPublicEventData = {
    eventTicker: "KXNBA-26",
    marketsByTicker: new Map([
      [
        "KXNBA-26-NOP",
        {
          ticker: "KXNBA-26-NOP",
          bestBid: 0,
          bestAsk: 0.01,
          noBid: 0.99,
          noAsk: 1,
          lastPrice: 0.01,
          volumeTotal: 37596,
          volume24h: 0,
          openInterest: 37596,
          liquidity: 0,
        },
      ],
    ]),
  };

  const enriched = applyKalshiPublicEventToMappedMarkets([mapped], publicEvent);
  const first = enriched.mappedMarkets[0];
  assert.ok(first);
  assert.equal(first.marketRow.best_bid, 0);
  assert.equal(first.marketRow.best_ask, 0.01);
  assert.equal(first.marketRow.last_price, 0.01);
  assert.equal(first.snapshot?.yesBid, 0);
  assert.equal(first.snapshot?.yesAsk, 0.01);
  assert.equal(first.snapshot?.noBid, 0.99);
  assert.equal(first.snapshot?.noAsk, 1);
  assert.equal(enriched.filledBestBid, 1);
  assert.equal(enriched.filledBestAsk, 0);
  assert.equal(enriched.filledLastPrice, 1);
});

test("Kalshi public enrichment leaves unmatched markets unchanged", () => {
  const mapped = mapToUnifiedMarket(
    makeMarket({
      ticker: "KXOTHER-YES",
      yesBid: 0.2,
      yesAsk: 0.3,
    }),
    "kalshi:KXOTHER",
    "Other event",
    "sports",
    DEFAULT_USDC_MINT,
    false,
  );

  assert.ok(mapped);

  const publicEvent: KalshiPublicEventData = {
    eventTicker: "KXNBA-26",
    marketsByTicker: new Map(),
  };

  const enriched = applyKalshiPublicEventToMappedMarkets([mapped], publicEvent);
  assert.equal(enriched.matchedMarkets, 0);
  assert.equal(enriched.updatedMarkets, 0);
  assert.deepEqual(enriched.mappedMarkets[0], mapped);
});
