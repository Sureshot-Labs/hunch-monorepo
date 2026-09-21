import assert from "node:assert/strict";
import {
  buildMapSearchDocuments,
  searchMapDocuments,
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
