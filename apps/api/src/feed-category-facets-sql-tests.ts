#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";

import { fetchFeedCategoryFacetRows } from "./repos/unified-read.js";

const executedSql: string[] = [];
const client = {
  query: async (sql: string) => {
    executedSql.push(sql);
    return { rows: [], rowCount: 0 };
  },
  release: () => undefined,
};
const pool = {
  connect: async () => client,
} as unknown as Pool;
const now = new Date("2026-08-28T12:00:00.000Z");
const inputs = {
  minVol: 0,
  minLiquidity: 0,
  venues: ["polymarket", "limitless"],
  view: "events" as const,
  nowParam: now.toISOString(),
  sevenDaysAgo: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
  sevenDaysFromNow: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
};

await fetchFeedCategoryFacetRows(pool, inputs);
const unfilteredFacetSql = executedSql.find((sql) =>
  /select\s+e\.venue as venue/i.test(sql),
);
assert.ok(unfilteredFacetSql);
assert.match(
  unfilteredFacetSql,
  /from unified_events e[\s\S]*?exists\s*\([\s\S]*?from unified_markets om/i,
);
assert.match(unfilteredFacetSql, /join polymarket_markets pm_om/i);
assert.doesNotMatch(unfilteredFacetSql, /orderable_market_candidates/i);
assert.ok(
  executedSql.some((sql) => /SET LOCAL statement_timeout = '\d+ms'/i.test(sql)),
);

executedSql.length = 0;
await fetchFeedCategoryFacetRows(pool, {
  ...inputs,
  eventScope: "grouped",
});
const scopedFacetSql = executedSql.find((sql) =>
  /orderable_market_candidates as materialized/i.test(sql),
);
assert.ok(scopedFacetSql);

executedSql.length = 0;
await fetchFeedCategoryFacetRows(pool, {
  ...inputs,
  durationMinutes: [60],
});
const durationFacetSql = executedSql.find((sql) =>
  /orderable_market_candidates as materialized/i.test(sql),
);
assert.ok(durationFacetSql);
console.log("ok - unfiltered event facets use indexed orderability exists");
