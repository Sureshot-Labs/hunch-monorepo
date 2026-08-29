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
let topSql = "";
const topParams: unknown[][] = [];
let eventSql = "";
const localStatements: string[] = [];
const probabilityMarketSourceQuery =
  /from probability_candidate_events candidate_event\s+join lateral|from probability_market_candidates probability_candidate\s+join unified_markets m on m\.id = probability_candidate\.market_id/i;
const client = {
  query: async (sql: string, params: unknown[] = []) => {
    localStatements.push(sql);
    if (probabilityMarketSourceQuery.test(sql)) {
      candidateSql = sql;
      return {
        rows: [
          {
            market_id: "market-1",
            token_yes: "yes-1",
            token_no: "no-1",
            clob_token_ids: null,
          },
          {
            market_id: "market-2",
            token_yes: null,
            token_no: null,
            clob_token_ids: JSON.stringify(["yes-2", "no-2"]),
          },
        ],
        rowCount: 2,
      };
    }
    if (/from unified_token_top_latest\s+where token_id = any/i.test(sql)) {
      topSql = sql;
      topParams.push(params);
      return {
        rows: [
          { token_id: "yes-1", best_bid: "0.79", best_ask: "0.81" },
          { token_id: "no-1", best_bid: "0.19", best_ask: "0.21" },
          { token_id: "yes-2", best_bid: "0.49", best_ask: "0.51" },
          { token_id: "no-2", best_bid: "0.49", best_ask: "0.51" },
        ],
        rowCount: 4,
      };
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
    ...commonInputs,
    minProb: 0.7,
    maxProb: undefined,
    candidateEventIds: ["event-1", "event-2"],
    venues: ["polymarket", "limitless"],
    categories: ["sports"],
    endWithin: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  }),
  ["market-1"],
);
assert.doesNotMatch(candidateSql, /interval '10 minutes'|\.ts\s*[<>]=?/i);
assert.doesNotMatch(
  candidateSql,
  /probability_market_candidates_strict_market_base/i,
);
assert.match(
  candidateSql,
  /probability_candidate_events as materialized[\s\S]*?lower\(e\.category\)/i,
);
assert.match(
  candidateSql,
  /unnest\(\$\d+::text\[\]\) as selected_event\(event_id\)[\s\S]*?join unified_events e on e\.id = selected_event\.event_id/i,
);
assert.match(
  candidateSql,
  /from probability_candidate_events candidate_event[\s\S]*?join lateral[\s\S]*?where m\.event_id = candidate_event\.id/i,
);
assert.match(candidateSql, /m\.status = 'ACTIVE'/i);
assert.match(candidateSql, /candidate_event\.status = 'ACTIVE'/i);
assert.match(candidateSql, /e\.venue = ANY\(\$\d+::text\[\]\)/i);
assert.match(candidateSql, /e\.end_date is not null/i);
assert.doesNotMatch(candidateSql, /observed_top_candidate_markets/i);
assert.match(
  candidateSql,
  /select\s+strict_market\.market_id,\s+strict_market\.token_yes,\s+strict_market\.token_no,\s+strict_market\.clob_token_ids/i,
);
assert.match(
  candidateSql,
  /probability_grace_market_ids as materialized[\s\S]*?pm_filter\.id = any\(grace_market_ids\.venue_market_ids\)/i,
);
assert.match(candidateSql, probabilityMarketSourceQuery);
assert.doesNotMatch(candidateSql, /unified_market_tokens/i);
assert.doesNotMatch(candidateSql, /left join lateral/i);
assert.match(
  candidateSql,
  /idx_unified_markets_active_event_id|m\.event_id = candidate_event\.id/i,
);
assert.doesNotMatch(candidateSql, /canonical_token_rows as materialized/i);
assert.doesNotMatch(candidateSql, /canonical_top_rows as materialized/i);
assert.doesNotMatch(candidateSql, /canonical_probabilities as materialized/i);
assert.doesNotMatch(candidateSql, /probability\s*[<>]=\s*\$\d+/i);
assert.match(topSql, /from unified_token_top_latest/i);
assert.match(topSql, /where token_id = any\(\$1::text\[\]\)/i);
assert.doesNotMatch(topSql, /canonical_token_pairs|array_agg|initplan/i);
assert.deepEqual(topParams, [[["yes-1", "yes-2"]], [["no-1"]]]);
assert.ok(
  localStatements.some((sql) =>
    /SET LOCAL statement_timeout = '\d+ms'/i.test(sql),
  ),
);
const candidateBatchQueryCount = localStatements.filter((sql) =>
  probabilityMarketSourceQuery.test(sql),
).length;
assert.deepEqual(
  await fetchObservedCanonicalProbabilityMarketIds(pool, {
    ...commonInputs,
    minProb: 0.4,
    maxProb: 0.6,
    candidateEventIds: ["event-2", "event-1"],
    venues: ["polymarket", "limitless"],
    categories: ["sports"],
    endWithin: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  }),
  ["market-2"],
);
assert.equal(
  localStatements.filter((sql) => probabilityMarketSourceQuery.test(sql))
    .length,
  candidateBatchQueryCount + 1,
);
assert.deepEqual(topParams.slice(-2), [[["yes-1", "yes-2"]], [["no-2"]]]);
console.log("ok - candidate event batches narrow NO tops for each range");
console.log("ok - feed probability candidates are scoped and time-bounded");

{
  let scopedCandidateSql = "";
  let scopedCandidateParams: unknown[] = [];
  const scopedTopParams: unknown[][] = [];
  const scopedClient = {
    query: async (sql: string, params: unknown[] = []) => {
      if (
        /select\s+selected_market\.market_id,\s+m\.token_yes,\s+m\.token_no,\s+m\.clob_token_ids/i.test(
          sql,
        )
      ) {
        scopedCandidateSql = sql;
        scopedCandidateParams = [...params];
        return {
          rows: [
            {
              market_id: "scoped-market-1",
              token_yes: "scoped-yes-1",
              token_no: "scoped-no-1",
              clob_token_ids: null,
            },
            {
              market_id: "scoped-market-2",
              token_yes: null,
              token_no: null,
              clob_token_ids: JSON.stringify(["scoped-yes-2", "scoped-no-2"]),
            },
          ],
          rowCount: 2,
        };
      }
      if (/from unified_token_top_latest\s+where token_id = any/i.test(sql)) {
        scopedTopParams.push(params);
        return {
          rows: [
            {
              token_id: "scoped-yes-1",
              best_bid: "0.79",
              best_ask: "0.81",
            },
            {
              token_id: "scoped-no-1",
              best_bid: "0.19",
              best_ask: "0.21",
            },
            {
              token_id: "scoped-yes-2",
              best_bid: "0.49",
              best_ask: "0.51",
            },
            {
              token_id: "scoped-no-2",
              best_bid: "0.49",
              best_ask: "0.51",
            },
          ],
          rowCount: 4,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  const scopedPool = {
    connect: async () => scopedClient,
  } as unknown as Pool;

  assert.deepEqual(
    await fetchObservedCanonicalProbabilityMarketIds(scopedPool, {
      ...commonInputs,
      minProb: 0.4,
      maxProb: 0.6,
      candidateMarketIds: ["scoped-market-1", "scoped-market-2"],
    }),
    ["scoped-market-2"],
  );
  assert.match(
    scopedCandidateSql,
    /from unnest\(\$1::text\[\]\)\s+as selected_market\(market_id\)\s+join unified_markets m on m\.id = selected_market\.market_id/i,
  );
  assert.doesNotMatch(
    scopedCandidateSql,
    /unified_market_tokens|probability_candidate_events|probability_market_candidates_strict_market_base|orderable_market_candidates/i,
  );
  assert.deepEqual(scopedCandidateParams, [
    ["scoped-market-1", "scoped-market-2"],
  ]);
  assert.deepEqual(scopedTopParams, [
    [["scoped-yes-1", "scoped-yes-2"]],
    [["scoped-no-2"]],
  ]);
}
console.log("ok - market probability maps only the ranked candidate batch");

const probabilityQueryCountBeforeSingleFlight = localStatements.filter((sql) =>
  probabilityMarketSourceQuery.test(sql),
).length;
const sharedScopeInputs = {
  ...commonInputs,
  venues: ["polymarket", "limitless"],
  endWithin: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
};
const [highRangeIds, middleRangeIds] = await Promise.all([
  fetchObservedCanonicalProbabilityMarketIds(pool, {
    ...sharedScopeInputs,
    minProb: 0.71,
    maxProb: 0.91,
  }),
  fetchObservedCanonicalProbabilityMarketIds(pool, {
    ...sharedScopeInputs,
    minProb: 0.4,
    maxProb: 0.6,
  }),
]);
assert.deepEqual(highRangeIds, ["market-1"]);
assert.deepEqual(middleRangeIds, ["market-2"]);
assert.equal(
  localStatements.filter((sql) => probabilityMarketSourceQuery.test(sql))
    .length,
  probabilityQueryCountBeforeSingleFlight + 2,
);
console.log("ok - probability ranges keep independent exact narrowed caches");

assert.deepEqual(
  await fetchFeedEventIds(pool, {
    ...commonInputs,
    marketIds: ["market-1"],
  }),
  [],
);
assert.match(
  eventSql,
  /orderable_market_candidates_strict_market_base as materialized[\s\S]*?from unified_markets m[\s\S]*?join unnest\(\$\d+::text\[\]\) as candidate_filter\(market_id\) on candidate_filter\.market_id = m\.id/i,
);
assert.match(
  eventSql,
  /orderable_market_candidates_pm_recent_candidates as materialized[\s\S]*?join unnest\(\$\d+::text\[\]\) as candidate_filter\(market_id\)[\s\S]*?m\.close_time[\s\S]*?or \([\s\S]*?m\.expiration_time[\s\S]*?union[\s\S]*?join unnest\(\$\d+::text\[\]\) as candidate_filter\(market_id\)[\s\S]*?e\.end_date/i,
);
assert.doesNotMatch(eventSql, /m\.id = ANY\(\$\d+::text\[\]\)/i);
console.log(
  "ok - event pagination drives every orderable branch from preselected market ids",
);
