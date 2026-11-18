import assert from "node:assert/strict";
import {
  marketMapTopic,
  mapTopicComposition,
} from "./services/market-map-topic.js";
import {
  qualityAbKeyMode,
  qualityPrompt,
} from "./product-quality-prompt-cases.js";
import {
  applyVenueFilterToNode,
  type MarketMapNode,
} from "./services/market-map.js";

assert.equal(
  marketMapTopic("sports", "atp-alcaraz-deminaur", null),
  "sports_tennis_game",
);
assert.equal(
  marketMapTopic("sports", "epl-arsenal-liverpool", null),
  "sports_soccer_game",
);
const mixed = mapTopicComposition([
  { topic: "sports_soccer_game" },
  { topic: "sports_tennis_game" },
  { topic: "sports_soccer_game" },
]);
assert.equal(mixed.dominant, "sports_soccer_game");
assert.equal(mixed.mixed, true);
assert.ok(mixed.prefer.every((x) => x.topic === "sports_soccer_game"));
assert.equal(
  mapTopicComposition([{ topic: "entertainment" }, { topic: "legal" }]).mixed,
  true,
);
assert.equal(
  mapTopicComposition([
    { topic: "entertainment" },
    { topic: "legal" },
    ...Array.from({ length: 20 }, () => ({ topic: null })),
  ]).dominant,
  null,
);
assert.match(qualityPrompt("writer", "candidate"), /price-only update/);
assert.doesNotMatch(qualityPrompt("writer", "current"), /price-only update/);
assert.throws(
  () => qualityAbKeyMode(["--execute", "--scout-only", "--use-configured-key"]),
  /require a dedicated capped key/,
);
assert.deepEqual(qualityAbKeyMode(["--use-configured-key"]), {
  shared: true,
  scoutOnly: false,
});
assert.deepEqual(qualityAbKeyMode(["--scout-only"]), {
  shared: false,
  scoutOnly: true,
});

const venueMetric = {
  eventCount: 1,
  sumVolume24h: 20,
  sumLiquidity: 50,
  sumOpenInterest: 100,
};
const mapNode: MarketMapNode = {
  id: "fixture",
  venue: "polymarket",
  dominantVenue: "polymarket",
  venueCount: 2,
  venueBreakdown: { polymarket: venueMetric, limitless: venueMetric },
  level: 1,
  parentId: null,
  childIds: [],
  label: "Fixture",
  labelRepresentative: "Fixture",
  labelAi: null,
  labelSource: "representative",
  x: 0,
  y: 0,
  eventCount: 2,
  sumVolume24h: 40,
  sumLiquidity: 100,
  sumOpenInterest: 200,
  score: 1,
  sampleEventIds: [],
  updatedAt: "2026-11-18T00:00:00Z",
  heroVenue: "limitless",
  heroEventId: "limitless:fixture",
  heroMarketId: "limitless:fixture:market",
  heroImage: "fixture-image",
  heroIcon: "fixture-icon",
  topicComposition: {
    scope: "whole_snapshot",
    dominant: "sports",
    mixed: true,
    known: 2,
  },
};
const filtered = applyVenueFilterToNode(mapNode, new Set(["polymarket"]));
assert.equal(filtered.eventCount, 1);
assert.equal(filtered.heroVenue, undefined);
assert.equal(filtered.heroEventId, null);
assert.equal(filtered.heroMarketId, null);
assert.equal(filtered.heroImage, null);
assert.equal(filtered.heroIcon, null);
assert.equal(filtered.topicComposition, mapNode.topicComposition);
assert.equal(
  applyVenueFilterToNode(mapNode, new Set(["limitless"])).heroMarketId,
  mapNode.heroMarketId,
);
assert.equal(applyVenueFilterToNode(mapNode, null).heroVenue, "limitless");

console.log("product-quality tests passed");
