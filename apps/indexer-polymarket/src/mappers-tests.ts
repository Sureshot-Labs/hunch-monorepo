import assert from "node:assert/strict";
import {
  deriveCategoryFromTags,
  mapToUnifiedMarket,
  resolvePolymarketCategory,
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
  assert.equal(category, "Politics");
});

test("resolvePolymarketCategory falls back conservatively for ceasefire text", () => {
  const category = resolvePolymarketCategory({
    title: "Russia x Ukraine ceasefire by March 31, 2026?",
    description:
      'This market will resolve to "Yes" if there is an official ceasefire agreement, defined as a publicly announced and mutually agreed halt in military engagement, between Russia and Ukraine.',
  });
  assert.equal(category, "Politics");
});

test("resolvePolymarketCategory does not misclassify 'defined' as defi", () => {
  const category = resolvePolymarketCategory({
    title: "Will a defined policy be announced?",
    description: "Defined terms only. No crypto content here.",
  });
  assert.notEqual(category, "Crypto");
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
  assert.equal(unified.category, "Politics");
});
