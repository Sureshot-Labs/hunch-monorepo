import assert from "node:assert/strict";

import type { DbQuery } from "./db.js";
import {
  DEFAULT_HOLDER_RESEARCH_CATEGORY_HORIZONS,
  holderResearchCategoryHorizonsSchema,
  resolveHolderResearchPublishHorizon,
} from "./services/holder-research-horizon.js";
import type { MarketSegment } from "./services/market-type-classifier.js";
import {
  getIntelPolicyDefaults,
  getIntelPolicySchema,
  resolveHolderResearchPolicy,
} from "./services/runtime-policies.js";

function dbWithPayload(payload: unknown): DbQuery {
  return {
    query: async () => ({
      rows:
        payload == null
          ? []
          : [
              {
                policy_key: "holder_research",
                payload,
                effective_at: new Date("2026-09-25T00:00:00Z"),
                created_at: new Date("2026-09-25T00:00:00Z"),
              },
            ],
    }),
  } as unknown as DbQuery;
}

const defaults = getIntelPolicyDefaults("holder_research");
assert.deepEqual(defaults.maxPublishHorizonHoursByCategory, {
  macro: 1_440,
  politics_geo: 1_440,
});
assert.equal(defaults.maxPublishHorizonHours, 720);

for (const marketSegment of [
  "macro_rates",
  "macro_commodities",
  "macro_equities",
  "politics_geo",
] as const) {
  assert.equal(
    resolveHolderResearchPublishHorizon({ policy: defaults, marketSegment })
      .maxHours,
    1_440,
  );
}

for (const marketSegment of [
  "crypto_btc",
  "crypto_eth",
  "crypto_alt",
  "sports_soccer_game",
  "sports_outright",
  "tech_ai",
  "entertainment",
  "weather",
  "health",
  "mentions",
  "other",
] as const) {
  assert.equal(
    resolveHolderResearchPublishHorizon({ policy: defaults, marketSegment })
      .maxHours,
    720,
  );
}

for (const payload of [null, {}, { maxPublishHorizonHours: 96 }]) {
  const resolved = await resolveHolderResearchPolicy(dbWithPayload(payload));
  assert.equal(resolved.invalidOverride, false);
  assert.deepEqual(
    resolved.effective.maxPublishHorizonHoursByCategory,
    DEFAULT_HOLDER_RESEARCH_CATEGORY_HORIZONS,
  );
  assert.equal(
    resolved.effective.maxPublishHorizonHours,
    payload?.maxPublishHorizonHours ?? 720,
  );
}

for (const rules of [{}, { macro: 240 }, { crypto: 48, politics_geo: 72 }]) {
  const resolved = await resolveHolderResearchPolicy(
    dbWithPayload({
      maxPublishHorizonHours: 96,
      maxPublishHorizonHoursByCategory: rules,
    }),
  );
  assert.equal(resolved.invalidOverride, false);
  assert.deepEqual(resolved.effective.maxPublishHorizonHoursByCategory, rules);
  const expected = Object.hasOwn(rules, "politics_geo") ? 72 : 96;
  assert.equal(
    resolveHolderResearchPublishHorizon({
      policy: resolved.effective,
      marketSegment: "politics_geo",
    }).maxHours,
    expected,
  );
}

for (const rules of [
  { macrro: 1_440 },
  { macro: 0 },
  { macro: -1 },
  { macro: 1.5 },
  { macro: Infinity },
  { macro: 87_601 },
  { macro: "1440" },
  { macro: true },
  { macro: null },
  null,
  [],
]) {
  assert.equal(
    holderResearchCategoryHorizonsSchema.safeParse(rules).success,
    false,
  );
  assert.equal(
    getIntelPolicySchema("holder_research").safeParse({
      maxPublishHorizonHoursByCategory: rules,
    }).success,
    false,
  );
}

for (const [marketSegment, category] of [
  ["sports_tennis_game", "single_game_sports"],
  ["sports_outright", "sports_outright"],
  ["tech_ai", "technology"],
  ["entertainment", "culture"],
] as const satisfies readonly (readonly [MarketSegment, string])[]) {
  assert.deepEqual(
    resolveHolderResearchPublishHorizon({
      marketSegment,
      policy: {
        maxPublishHorizonHours: 720,
        maxPublishHorizonHoursByCategory: { [category]: 12 },
      },
    }),
    { category, maxHours: 12, source: "category" },
  );
}

assert.deepEqual(
  resolveHolderResearchPublishHorizon({
    marketSegment: "macro_rates",
    policy: { maxPublishHorizonHours: 96 },
  }),
  { category: "macro", maxHours: 96, source: "fallback" },
);

const invalid = await resolveHolderResearchPolicy(
  dbWithPayload({ maxPublishHorizonHoursByCategory: { macrro: 1_440 } }),
);
assert.equal(invalid.invalidOverride, true);
assert.deepEqual(
  invalid.effective.maxPublishHorizonHoursByCategory,
  DEFAULT_HOLDER_RESEARCH_CATEGORY_HORIZONS,
);
const repaired = await resolveHolderResearchPolicy(
  dbWithPayload({ maxPublishHorizonHoursByCategory: {} }),
);
assert.equal(repaired.invalidOverride, false);
assert.deepEqual(repaired.effective.maxPublishHorizonHoursByCategory, {});

console.log("holder research horizon tests passed");
