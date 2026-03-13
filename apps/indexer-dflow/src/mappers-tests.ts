import assert from "node:assert/strict";

import {
  mapToUnifiedEvent,
  mapToUnifiedMarket,
  resolveDflowEventCategory,
  resolveDflowMarketCategory,
} from "./mappers.js";
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
