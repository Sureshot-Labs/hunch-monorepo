import assert from "node:assert/strict";
import {
  deriveCategoryFromTags,
  mapPolymarketEventRow,
  mapToUnifiedMarket,
  resolvePolymarketEventCategory,
  resolvePolymarketCategory,
  resolvePolymarketMarketCategory,
} from "./mappers.js";
import type { TPolymarketEvent, TPolymarketMarket } from "./types.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("deriveCategoryFromTags prefers politics/geopolitics tags", () => {
  const category = deriveCategoryFromTags([
    { label: "Geopolitics", slug: "geopolitics" },
    { label: "Foreign Policy", slug: "foreign-policy" },
    { label: "Ukraine", slug: "ukraine" },
    { label: "Politics", slug: "politics" },
  ]);
  assert.equal(category, "politics");
});

test("deriveCategoryFromTags prefers mentions when mention tags are present", () => {
  const category = deriveCategoryFromTags([
    { label: "Politics", slug: "politics" },
    { label: "Mention Markets", slug: "mention-markets" },
  ]);
  assert.equal(category, "mentions");
});

test("deriveCategoryFromTags maps sports leagues to sports", () => {
  const category = deriveCategoryFromTags([
    { label: "Premier League", slug: "premier-league" },
  ]);
  assert.equal(category, "sports");
});

test("deriveCategoryFromTags maps esports to sports", () => {
  const category = deriveCategoryFromTags([
    { label: "Counter-Strike 2", slug: "counter-strike-2" },
  ]);
  assert.equal(category, "sports");
});

test("resolvePolymarketCategory normalizes explicit categories", () => {
  assert.equal(
    resolvePolymarketCategory({
      explicitCategory: "science and technology",
      title: "Will a space launch happen?",
      description: "Space and science category normalization",
    }),
    "technology",
  );
  assert.equal(
    resolvePolymarketCategory({
      explicitCategory: "financials",
      title: "Will a bank beat earnings?",
      description: "Financial category normalization",
    }),
    "economics",
  );
});

test("resolvePolymarketCategory falls back conservatively for ceasefire text", () => {
  const category = resolvePolymarketCategory({
    title: "Russia x Ukraine ceasefire by March 31, 2026?",
    description:
      'This market will resolve to "Yes" if there is an official ceasefire agreement, defined as a publicly announced and mutually agreed halt in military engagement, between Russia and Ukraine.',
  });
  assert.equal(category, "politics");
});

test("resolvePolymarketCategory does not misclassify 'defined' as defi", () => {
  const category = resolvePolymarketCategory({
    title: "Will a defined policy be announced?",
    description: "Defined terms only. No crypto content here.",
  });
  assert.notEqual(category, "crypto");
});

test("market mapping inherits event tags when market category is missing", () => {
  const event = {
    id: "31759",
    title: "Russia x Ukraine ceasefire by March 31, 2026?",
    description: "A ceasefire agreement between Russia and Ukraine.",
    category: null,
    tags: [
      { label: "Geopolitics", slug: "geopolitics" },
      { label: "Foreign Policy", slug: "foreign-policy" },
    ],
    markets: [],
  } as unknown as TPolymarketEvent;
  const market = {
    id: "561829",
    question: "Russia x Ukraine ceasefire by March 31, 2026?",
    description: "A ceasefire agreement between Russia and Ukraine.",
    category: null,
    active: true,
    closed: false,
  } as unknown as TPolymarketMarket;

  const unified = mapToUnifiedMarket(market, event.id, event);
  assert.equal(unified.category, "politics");
});

test("market mapping closes inactive Polymarket child markets", () => {
  const event = {
    id: "31875",
    title: "Republican Presidential Nominee 2028",
    category: "politics",
    markets: [],
  } as unknown as TPolymarketEvent;
  const market = {
    id: "562009",
    question: "Will an inactive candidate slot win?",
    groupItemTitle: "Inactive Slot",
    active: false,
    closed: false,
    archived: false,
    acceptingOrders: true,
  } as unknown as TPolymarketMarket;

  const unified = mapToUnifiedMarket(market, event.id, event);
  assert.equal(unified.status, "CLOSED");
});

test("event backfill resolver matches live event mapping", () => {
  const event = {
    id: "1",
    title: "Will a major AI company announce a new model?",
    description: "Science and technology event",
    category: "science and technology",
    tags: [],
    markets: [],
  } as unknown as TPolymarketEvent;

  const liveCategory = resolvePolymarketCategory({
    explicitCategory: event.category,
    tags: (event as Record<string, unknown>).tags,
    title: event.title,
    description: event.description,
  });
  const backfillCategory = resolvePolymarketEventCategory({
    raw: event,
    explicitCategory: event.category,
    title: event.title,
    description: event.description,
  });

  assert.equal(backfillCategory, liveCategory);
});

test("Polymarket event raw omits nested markets but keeps event metadata", () => {
  const event = {
    id: "1",
    title: "Will a major AI company announce a new model?",
    description: "Science and technology event",
    category: "science and technology",
    tags: [{ label: "AI", slug: "ai" }],
    series: [{ title: "AI", slug: "ai" }],
    markets: [
      {
        id: "101",
        question: "Nested market should live in polymarket_markets.raw",
      },
    ],
  } as unknown as TPolymarketEvent;

  const row = mapPolymarketEventRow(event);
  const raw = row.raw as Record<string, unknown>;

  assert.equal(raw.title, event.title);
  assert.deepEqual(raw.tags, [{ label: "AI", slug: "ai" }]);
  assert.deepEqual(raw.series, [{ title: "AI", slug: "ai" }]);
  assert.equal("markets" in raw, false);
});

test("market backfill resolver matches live market mapping", () => {
  const event = {
    id: "31759",
    title: "Russia x Ukraine ceasefire by March 31, 2026?",
    description: "A ceasefire agreement between Russia and Ukraine.",
    category: null,
    tags: [
      { label: "Geopolitics", slug: "geopolitics" },
      { label: "Foreign Policy", slug: "foreign-policy" },
    ],
    markets: [],
  } as unknown as TPolymarketEvent;
  const market = {
    id: "561829",
    question: "Russia x Ukraine ceasefire by March 31, 2026?",
    description: "A ceasefire agreement between Russia and Ukraine.",
    category: null,
    active: true,
    closed: false,
  } as unknown as TPolymarketMarket;

  const liveCategory = mapToUnifiedMarket(market, event.id, event).category;
  const backfillCategory = resolvePolymarketMarketCategory({
    marketRaw: market,
    eventRaw: event,
    marketCategory: market.category,
    eventCategory: event.category,
    title: market.question,
    description: market.description,
  });

  assert.equal(backfillCategory, liveCategory);
});
