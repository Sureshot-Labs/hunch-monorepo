import assert from "node:assert/strict";
import {
  buildMapSearchDocuments,
  searchMapDocuments,
  buildMapSearchView,
  hydrateMapSearchDocuments,
} from "./services/market-map-text-search.js";
import { marketMapSearchQuerySchema } from "./schemas/market-map.js";
import type {
  MarketMapNode,
  MarketMapEventSummary,
} from "./services/market-map.js";

const nodes = [
  {
    id: "root",
    parentId: null,
    label: "Crypto",
    labelRepresentative: "",
    labelAi: null,
  },
  {
    id: "leaf",
    parentId: "root",
    label: "Bitcoin",
    labelRepresentative: "",
    labelAi: null,
  },
  {
    id: "other",
    parentId: null,
    label: "Elections",
    labelRepresentative: "",
    labelAi: null,
  },
] as MarketMapNode[];
const event = (eventId: string, title: string, venue = "polymarket") =>
  ({ eventId, title, venue }) as MarketMapEventSummary;
const documents = buildMapSearchDocuments(
  nodes,
  new Map([
    [
      "leaf",
      [
        event("a", "Bitcoin above $100,000 in 2026?"),
        event("b", "Ethereum — September 21?", "limitless"),
      ],
    ],
    ["other", [event("c", "Выборы президента 2028"), event("a", "Duplicate")]],
  ]),
);
const hiddenLabelDocs = buildMapSearchDocuments(
  nodes.map((node) => ({
    ...node,
    labelRepresentative: "Hidden Taiwan title",
  })),
  new Map([["leaf", [event("hidden-label", "Bitcoin price")]]]),
);
assert.equal(
  searchMapDocuments(hiddenLabelDocs, "Taiwan", ["polymarket"], 50).total,
  0,
);
assert.equal(documents.length, 3);
assert.equal(
  searchMapDocuments(documents, "crypto", ["polymarket", "limitless"], 50)
    .total,
  2,
);
const result = searchMapDocuments(documents, "CRYPTO 2026", ["polymarket"], 50);
assert.deepEqual(
  result.items.map((item) => item.eventId),
  ["a"],
);
assert.deepEqual(result.items[0].nodeIds, ["leaf", "root"]);
assert.equal("text" in result.items[0], false);
assert.equal(
  searchMapDocuments(documents, "Ethereum", ["polymarket"], 50).total,
  0,
);
assert.equal(
  searchMapDocuments(documents, "ВЫБОРЫ 2028", ["polymarket"], 50).total,
  1,
);
assert.equal(searchMapDocuments(documents, "!!!", ["polymarket"], 50).total, 0);
assert.equal(searchMapDocuments(documents, "Crypto", [], 50).total, 0);
const page = searchMapDocuments(
  documents,
  "Crypto",
  ["polymarket", "limitless"],
  1,
  1,
);
assert.equal(page.total, 2);
assert.equal(page.items.length, 1);
assert.equal(
  page.nodes.find((node) => node.id === "root")?.matchedEventCount,
  2,
);
assert.equal(
  searchMapDocuments(documents, "Crypto", ["polymarket"], 50, 999).items.length,
  0,
);
assert.equal(
  marketMapSearchQuerySchema.parse({ q: "b", offset: 100001 }).offset,
  100001,
);
assert.equal(marketMapSearchQuerySchema.safeParse({ q: " " }).success, false);
assert.equal(
  marketMapSearchQuerySchema.safeParse({ q: "a".repeat(501) }).success,
  false,
);
assert.equal(
  marketMapSearchQuerySchema.safeParse({ q: "bitcoin", limit: 0 }).success,
  false,
);
console.log(
  "ok - snapshot text search: titles, ancestors, Unicode, venue scope, deduplication, paging and query contract",
);

const viewNodes = nodes.map((node) => ({
  ...node,
  childIds: node.id === "root" ? ["leaf"] : [],
}));
const viewEvents = new Map([
  [
    "leaf",
    [
      {
        ...event("a", "Bitcoin above 100,000?"),
        volume24h: 20,
        liquidity: 30,
        openInterest: 40,
        signalCount: 1,
        topSignal: {
          title: "Bitcoin catalyst",
          createdAt: "2026-09-21T00:00:00Z",
        },
      },
      {
        ...event("b", "Ethereum below 2,000?", "limitless"),
        volume24h: 300,
        liquidity: 400,
        openInterest: 500,
      },
    ],
  ],
] as Array<[string, MarketMapEventSummary[]]>);
const viewDocs = buildMapSearchDocuments(viewNodes, viewEvents);
const view = buildMapSearchView(viewNodes, viewDocs, "above", [
  "polymarket",
  "limitless",
]);
assert.equal(view.events.length, 1);
assert.equal(view.nodes.length, 2);
assert.equal(view.nodes[0].eventCount, 1);
assert.equal(view.nodes[0].sumVolume24h, 20);
assert.equal(view.nodes[0].sumLiquidity, 30);
assert.equal(view.nodes[0].sumOpenInterest, 40);
assert.equal(view.nodes[0].heroEventId, "a");
assert.deepEqual(Object.keys(view.nodes[0].venueBreakdown), ["polymarket"]);
assert.equal(view.nodes[0].signalCountSubtree, 1);
assert.equal(view.nodes[0].topSignal?.title, "Bitcoin catalyst");
assert.deepEqual(view.events[0].nodeIds, ["leaf", "root"]);
assert.equal(
  "event" in searchMapDocuments(viewDocs, "above", ["polymarket"], 50).items[0],
  false,
);
assert.deepEqual(
  buildMapSearchView(viewNodes, viewDocs, "not present", ["polymarket"]),
  { nodes: [], events: [] },
);
assert.equal(
  buildMapSearchView(viewNodes, viewDocs, "crypto", ["limitless"]).nodes[0]
    .sumVolume24h,
  300,
);
assert.equal(
  viewNodes[0].eventCount,
  undefined,
  "search must not mutate snapshot nodes",
);
assert.equal(
  marketMapSearchQuerySchema.parse({ q: "a", includeView: "false" })
    .includeView,
  "false",
);
console.log(
  "ok - filtered view retains hierarchy, metadata and signals; excludes hidden metrics; leaves the snapshot untouched",
);

const fixtureSignal = viewEvents.get("leaf")?.[0].topSignal;
assert.ok(fixtureSignal);
const signalNodes = viewNodes.map((node) => ({
  ...node,
  signalsPreview: [
    { ...fixtureSignal, title: "Theme update" },
    {
      ...fixtureSignal,
      title: "Hidden Ethereum",
      targetEventId: "b",
    },
    {
      ...fixtureSignal,
      title: "Disabled venue",
      targetVenue: "kalshi",
    },
  ],
}));
const signalView = buildMapSearchView(signalNodes, viewDocs, "above", [
  "polymarket",
]);
assert.deepEqual(
  signalView.nodes[0].signalsPreview?.map((signal) => signal.title),
  ["Theme update", "Bitcoin catalyst"],
);
assert.equal(signalView.nodes[0].signalCountDirect, 1);

const hydrationCache = new Map<string, Promise<MarketMapEventSummary | null>>();
const hydrationCalls: string[][] = [];
const hydrate = async (events: MarketMapEventSummary[]) => {
  hydrationCalls.push(events.map((item) => item.eventId));
  await new Promise((resolve) => setTimeout(resolve, 5));
  return events;
};
const [firstHydration, secondHydration] = await Promise.all([
  hydrateMapSearchDocuments(viewDocs.slice(0, 1), hydrationCache, hydrate),
  hydrateMapSearchDocuments(viewDocs, hydrationCache, hydrate),
]);
assert.deepEqual(hydrationCalls, [["a"], ["b"]]);
assert.equal(firstHydration.length, 1);
assert.equal(secondHydration.length, 2);
await hydrateMapSearchDocuments(viewDocs, hydrationCache, hydrate);
assert.equal(
  hydrationCalls.length,
  2,
  "repeated searches must not repeat DB enrichment",
);
const failureCache = new Map<string, Promise<MarketMapEventSummary | null>>();
await assert.rejects(
  hydrateMapSearchDocuments(viewDocs, failureCache, async () => {
    throw new Error("temporary");
  }),
);
assert.equal(failureCache.size, 0);
assert.equal(
  (await hydrateMapSearchDocuments(viewDocs, failureCache, hydrate)).length,
  2,
);
const closedCache = new Map<string, Promise<MarketMapEventSummary | null>>();
assert.equal(
  (await hydrateMapSearchDocuments(viewDocs, closedCache, async () => []))
    .length,
  0,
);
assert.equal(
  (await hydrateMapSearchDocuments(viewDocs, closedCache, hydrate)).length,
  0,
  "cache confirmed unusable entities too",
);
console.log(
  "ok - concurrent hydration deduplication, bounded entity cache, temporary-error recovery and unusable events",
);
