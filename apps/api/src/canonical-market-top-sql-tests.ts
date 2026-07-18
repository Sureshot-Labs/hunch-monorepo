#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";

import {
  buildObservedCanonicalMarketProbabilityPredicateSql,
  buildObservedCanonicalMarketProbabilitySql,
  buildObservedCanonicalProbabilityFromTopSql,
  fetchFeedEventIds,
  fetchObservedCanonicalProbabilityMarketIds,
} from "./repos/unified-read.js";

const observedMarket = buildObservedCanonicalMarketProbabilitySql({
  marketAlias: "m",
});
assert.match(observedMarket, /unified_token_top_latest canonical_yes_top/i);
assert.match(observedMarket, /unified_token_top_latest canonical_no_top/i);
assert.doesNotMatch(observedMarket, /interval '10 minutes'|\.ts\s*[<>]=?/i);
assert.match(observedMarket, /abs\(/i);
assert.match(observedMarket, /1 -/i);
assert.doesNotMatch(observedMarket, /m\.best_bid|m\.best_ask/i);
console.log("ok - feed probability uses observed canonical token tops");

const predicate = buildObservedCanonicalMarketProbabilityPredicateSql({
  marketAlias: "m",
  minProbParam: "$1",
  maxProbParam: "$2",
});
assert.ok(predicate);
assert.match(predicate, /canonical_probability\.probability >= \$1/i);
assert.match(predicate, /canonical_probability\.probability <= \$2/i);
assert.equal(
  predicate.match(/unified_token_top_latest canonical_yes_top/gi)?.length,
  1,
);
assert.equal(
  predicate.match(/unified_token_top_latest canonical_no_top/gi)?.length,
  1,
);
console.log(
  "ok - observed probability predicate performs one canonical lookup",
);

const observed = buildObservedCanonicalProbabilityFromTopSql({
  yesAlias: "yes_top",
  noAlias: "no_top",
});
assert.doesNotMatch(observed, /interval '10 minutes'/i);
assert.match(observed, /yes_top\.best_bid <= yes_top\.best_ask/i);
assert.match(observed, /no_top\.best_bid <= no_top\.best_ask/i);
assert.match(observed, /abs\(/i);
assert.match(observed, /1 -/i);
console.log(
  "ok - observed probability keeps age out of presentation semantics",
);

let candidateSql = "";
let eventSql = "";
const client = {
  query: async (sql: string) => {
    if (/observed_top_candidate_markets as materialized/i.test(sql)) {
      candidateSql = sql;
      return { rows: [{ market_id: "market-1" }], rowCount: 1 };
    }
    if (/orderable_market_candidates as materialized/i.test(sql)) {
      eventSql = sql;
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  },
  release: () => undefined,
};
const pool = {
  connect: async () => client,
} as unknown as Pool;
const now = new Date("2026-07-17T12:00:00.000Z");
const commonInputs = {
  limit: 20,
  offset: 0,
  minVol: 0,
  minLiquidity: 0,
  nowParam: now.toISOString(),
  sevenDaysAgo: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
  sevenDaysFromNow: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
  sort: "trending",
  sortDir: "desc" as const,
  view: "events" as const,
};

assert.deepEqual(
  await fetchObservedCanonicalProbabilityMarketIds(pool, {
    minProb: 0.7,
    maxProb: undefined,
  }),
  ["market-1"],
);
assert.doesNotMatch(candidateSql, /interval '10 minutes'|\.ts\s*[<>]=?/i);
assert.match(candidateSql, /market\.status = 'ACTIVE'/i);
assert.match(candidateSql, /event\.status = 'ACTIVE'/i);
assert.match(candidateSql, /observed_top\.best_bid between 0 and 1/i);
assert.match(candidateSql, /canonical_probabilities as materialized/i);
assert.match(candidateSql, /probability >= \$1/i);
console.log("ok - feed probability candidates retain old coherent tops");

assert.deepEqual(
  await fetchFeedEventIds(pool, {
    ...commonInputs,
    marketIds: ["market-1"],
  }),
  [],
);
assert.match(eventSql, /m\.id = ANY\(\$\d+::text\[\]\)/i);
assert.match(
  eventSql,
  /orderable_market_candidates_strict_market_base as materialized[\s\S]*?where[\s\S]*?m\.id = ANY\(\$\d+::text\[\]\)/i,
);
assert.match(
  eventSql,
  /orderable_market_candidates_pm_recent_candidates as materialized[\s\S]*?m\.close_time[\s\S]*?m\.id = ANY\(\$\d+::text\[\]\)[\s\S]*?union all[\s\S]*?m\.expiration_time[\s\S]*?m\.id = ANY\(\$\d+::text\[\]\)[\s\S]*?union all[\s\S]*?e\.end_date[\s\S]*?m\.id = ANY\(\$\d+::text\[\]\)/i,
);
console.log(
  "ok - event pagination drives every orderable branch from preselected market ids",
);
