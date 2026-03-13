import assert from "node:assert/strict";
import {
  mapToUnifiedEvent,
  mapToUnifiedMarket,
  resolveLimitlessCategory,
} from "./mappers.js";
import type { TLimitlessMarket, TLimitlessMarketItem } from "./types.js";

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
  overrides: Partial<TLimitlessMarket> = {},
): TLimitlessMarket {
  return {
    id: 1,
    slug: "test-event",
    title: "Test event",
    tags: [],
    status: "ACTIVE",
    creator: { name: "Limitless", imageURI: "", link: "" },
    expired: false,
    metadata: {},
    createdAt: "2026-03-12T00:00:00Z",
    tradeType: "clob",
    updatedAt: "2026-03-12T00:00:00Z",
    categories: [],
    marketType: "single",
    volume: "0",
    volumeFormatted: "0",
    trends: undefined,
    description: "",
    venue: null,
    ...overrides,
  } as TLimitlessMarket;
}

function makeMarket(
  overrides: Partial<TLimitlessMarketItem> = {},
): TLimitlessMarketItem {
  return {
    id: 11,
    slug: "test-market",
    title: "Test market",
    tags: [],
    status: "ACTIVE",
    creator: { name: "Limitless", imageURI: "", link: "" },
    expired: false,
    metadata: {},
    createdAt: "2026-03-12T00:00:00Z",
    updatedAt: "2026-03-12T00:00:00Z",
    categories: [],
    marketType: "single",
    volume: "0",
    volumeFormatted: "0",
    description: "",
    venue: null,
    ...overrides,
  } as TLimitlessMarketItem;
}

test("resolveLimitlessCategory prefers structured crypto domain over 15 min", () => {
  const category = resolveLimitlessCategory({
    categories: ["Crypto", "15 min", "Bitcoin"],
    tags: ["Lumy", "Recurring", "Minutely", "Minutes 15", "nav:domain:crypto"],
    title: "$BTC above $95k in 15 min?",
  });
  assert.equal(category, "crypto");
});

test("resolveLimitlessCategory maps solana+crypto mixed categories to crypto", () => {
  const category = resolveLimitlessCategory({
    categories: ["Solana", "Crypto", "15 min"],
    tags: ["Recurring", "Minutes 15"],
    title: "$SOL above $180 in 15 min?",
  });
  assert.equal(category, "crypto");
});

test("resolveLimitlessCategory uses tags when categories are only recurring markers", () => {
  const category = resolveLimitlessCategory({
    categories: ["hourly"],
    tags: ["nav:domain:crypto", "Recurring"],
    title: "$ETH above $4k hourly?",
  });
  assert.equal(category, "crypto");
});

test("resolveLimitlessCategory maps football matches to sports", () => {
  const category = resolveLimitlessCategory({
    categories: ["football matches"],
    tags: [],
    title: "Arsenal vs Chelsea",
  });
  assert.equal(category, "sports");
});

test("resolveLimitlessCategory maps off the pitch to sports", () => {
  const category = resolveLimitlessCategory({
    categories: ["off the pitch"],
    tags: [],
    title: "Will a manager be fired?",
  });
  assert.equal(category, "sports");
});

test("resolveLimitlessCategory maps company news to economics", () => {
  const category = resolveLimitlessCategory({
    categories: ["company news"],
    tags: [],
    title: "Will Apple beat earnings?",
  });
  assert.equal(category, "economics");
});

test("resolveLimitlessCategory keeps crypto when mixed with lower-priority source categories", () => {
  const category = resolveLimitlessCategory({
    categories: ["Crypto", "Other", "Company News"],
    tags: ["Limitless"],
    title: "Will Binance list token X?",
  });
  assert.equal(category, "crypto");
});

test("resolveLimitlessCategory maps finance-domain tags to economics", () => {
  const category = resolveLimitlessCategory({
    categories: ["This vs That"],
    tags: ["nav:domain:finance"],
    title: "Hope vs Fear",
  });
  assert.equal(category, "economics");
});

test("resolveLimitlessCategory keeps politics as politics", () => {
  const category = resolveLimitlessCategory({
    categories: ["politics"],
    tags: [],
    title: "Will candidate X win?",
  });
  assert.equal(category, "politics");
});

test("resolveLimitlessCategory treats 15 min with no better signal as other", () => {
  const category = resolveLimitlessCategory({
    categories: ["15 min"],
    tags: ["Recurring", "Minutes 15"],
    title: "Unknown short market",
  });
  assert.equal(category, "other");
});

test("resolveLimitlessCategory maps culture to entertainment", () => {
  const category = resolveLimitlessCategory({
    categories: ["culture"],
    tags: [],
    title: "Will this movie win an award?",
  });
  assert.equal(category, "entertainment");
});

test("mapToUnifiedEvent uses normalized category instead of first source category", () => {
  const event = makeEvent({
    categories: ["hourly", "Crypto"],
    tags: ["nav:domain:crypto"],
    title: "$BTC hourly direction",
  });
  const unified = mapToUnifiedEvent(event);
  assert.equal(unified.category, "crypto");
});

test("mapToUnifiedMarket falls back to event signals when market categories are junk", () => {
  const event = makeEvent({
    categories: ["politics"],
    tags: ["politics"],
    title: "Election event",
    description: "Election event",
  });
  const market = makeMarket({
    categories: ["15 min"],
    tags: ["Recurring"],
    title: "Election market",
    description: "Election market",
  });
  const unified = mapToUnifiedMarket(market, String(event.id), event);
  assert.equal(unified.category, "politics");
});
