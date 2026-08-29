#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";

import {
  type FeedInputs,
  fetchFeedEventIds,
  fetchFeedMarketIdsForProbabilityProbe,
  fetchFeedMarketsDirect,
} from "./repos/unified-read.js";

const now = new Date("2026-08-28T12:00:00.000Z");
const baseInputs = {
  limit: 3,
  offset: 0,
  minVol: 0,
  minLiquidity: 0,
  view: "markets",
  sortDir: "desc",
  nowParam: now.toISOString(),
  sevenDaysAgo: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
  sevenDaysFromNow: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
} satisfies FeedInputs;

function isTransactionStatement(sql: string): boolean {
  const normalized = sql.trim().toLowerCase();
  return (
    normalized === "begin" ||
    normalized === "commit" ||
    normalized === "rollback" ||
    normalized.startsWith("set local ")
  );
}

function createCapturePool(args: {
  candidateRows: Array<Array<Record<string, unknown>>>;
  capturedSql: string[];
  capturedParams: unknown[][];
}): Pool {
  let candidateQueryIndex = 0;
  const runQuery = async (sql: string, params: unknown[] = []) => {
    if (isTransactionStatement(sql)) return { rows: [], rowCount: 0 };
    args.capturedSql.push(sql);
    args.capturedParams.push([...params]);
    candidateQueryIndex += 1;
    return {
      rows: args.candidateRows[candidateQueryIndex - 1] ?? [],
      rowCount: 0,
    };
  };
  return {
    query: runQuery,
    async connect() {
      return { query: runQuery, release() {} };
    },
  } as unknown as Pool;
}

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [
      [
        {
          ids: [],
          non_limitless_prefix_count: 1_000,
          non_limitless_valid_count: 0,
          limitless_candidate_count: 0,
          limitless_valid_count: 0,
        },
      ],
      [
        {
          ids: ["market-1"],
          non_limitless_prefix_count: 2_000,
          non_limitless_valid_count: 1,
          limitless_candidate_count: 0,
          limitless_valid_count: 0,
        },
      ],
      [],
    ],
  });

  await fetchFeedMarketsDirect(pool, {
    ...baseInputs,
    limit: 1,
    venues: ["polymarket"],
    sort: "trending_v2",
  });

  assert.match(
    capturedSql[0],
    /non_limitless_metric_prefix as materialized[\s\S]*?from unified_market_trade_24h metric[\s\S]*?order by metric\.volume_24h desc nulls last, metric\.market_id[\s\S]*?limit \$\d+/i,
  );
  assert.match(
    capturedSql[0],
    /non_limitless_metric_generation as materialized[\s\S]*?max\(metric_generation\.updated_at\)[\s\S]*?metric\.updated_at = \([\s\S]*?from non_limitless_metric_generation metric_generation/i,
  );
  assert.match(
    capturedSql[0],
    /non_limitless_ranked_candidates as materialized[\s\S]*?from non_limitless_metric_prefix metric_prefix[\s\S]*?join unified_markets metric_market on metric_market\.id = metric_prefix\.market_id/i,
  );
  assert.match(
    capturedSql[0],
    /count\(\*\)::int from non_limitless_metric_prefix\) as non_limitless_prefix_count/i,
  );
  assert.doesNotMatch(
    capturedSql[0],
    /from unified_market_trade_24h metric\s+join unified_markets metric_market/i,
  );
  assert.ok(capturedParams[0]?.includes(1_000));
  assert.ok(capturedParams[1]?.includes(4_000));
}
console.log("ok - trending v2 bounds metric rows before market lookups");

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [
      [
        {
          ids: ["market-1", "market-2", "market-3"],
          non_limitless_prefix_count: 1_000,
          non_limitless_valid_count: 2,
          limitless_candidate_count: 449,
          limitless_valid_count: 3,
          non_limitless_remainder_below_page: true,
          limitless_remainder_below_page: false,
        },
      ],
      [],
    ],
  });

  await fetchFeedMarketsDirect(pool, {
    ...baseInputs,
    sort: "trending_v2",
  });

  assert.equal(capturedSql.length, 2);
  assert.match(
    capturedSql[0],
    /min\(trend_score\) from combined_page[\s\S]*?> \(select min\(volume_24h\) from non_limitless_metric_prefix\)[\s\S]*?as non_limitless_remainder_below_page/i,
  );
  assert.ok(capturedParams[0]?.includes(1_000));
  assert.equal(
    capturedParams.some((params) => params.includes(4_000)),
    false,
  );
}
console.log("ok - trending v2 stops when a full page dominates the remainder");

const projectedSortPatterns: Record<string, RegExp> = {
  trending:
    /candidate_market\.volume_total[\s\S]*?\* 0\.4[\s\S]*?candidate_market\.event_start_date/i,
  totalvol: /candidate_market\.volume_total is not null/i,
  liquidity:
    /nullif\(candidate_market\.liquidity, 0\)[\s\S]*?nullif\(candidate_market\.open_interest, 0\)/i,
  openinterest: /candidate_market\.open_interest/i,
  time: /candidate_market\.close_time[\s\S]*?candidate_market\.expiration_time[\s\S]*?candidate_market\.event_end_date/i,
};

for (const [sort, sortPattern] of Object.entries(projectedSortPatterns)) {
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [[{ ids: ["market-1", "market-2", "market-3"] }], []],
  });

  await fetchFeedMarketsDirect(pool, {
    ...baseInputs,
    offset: 25,
    sort,
  });

  const candidateSql = capturedSql[0];
  assert.match(candidateSql, /orderable_market_candidates as materialized/i);
  assert.match(
    candidateSql,
    /orderable_market_candidates_strict_market_base as materialized[\s\S]*?m\.venue_market_id[\s\S]*?m\.volume_total[\s\S]*?m\.liquidity/i,
  );
  assert.match(
    candidateSql,
    /orderable_market_candidates_strict_candidates as materialized[\s\S]*?from orderable_market_candidates_strict_market_base m\s+join unified_events e on e\.id = m\.event_id/i,
  );
  assert.match(
    candidateSql,
    /orderable_market_candidates_strict_ranked_candidates as materialized[\s\S]*?from orderable_market_candidates_strict_candidates candidate_market[\s\S]*?limit \$\d+/i,
  );
  assert.match(
    candidateSql,
    /orderable_market_candidates_pm_ranked_candidates as materialized[\s\S]*?from orderable_market_candidates_pm_unvalidated_candidates candidate_market[\s\S]*?limit \$\d+/i,
  );
  assert.match(
    candidateSql,
    /orderable_market_candidates_pm_candidate_ids as materialized[\s\S]*?from orderable_market_candidates_pm_ranked_candidates/i,
  );
  const strictCandidateSql = candidateSql.match(
    /orderable_market_candidates_strict_candidates as materialized[\s\S]*?(?=,\s*orderable_market_candidates_pm_recent_candidates as materialized)/i,
  )?.[0];
  assert.ok(strictCandidateSql);
  assert.doesNotMatch(strictCandidateSql, /join unified_markets m on m\.id/i);
  assert.match(
    candidateSql,
    /ranked_market_page as materialized[\s\S]*?from orderable_market_candidates candidate_market/i,
  );
  assert.doesNotMatch(
    candidateSql,
    /ranked_market_page as materialized[\s\S]*?join unified_(?:markets|events)/i,
  );
  assert.match(candidateSql, sortPattern);
  assert.ok(capturedParams[0]?.includes(3));
  assert.ok(capturedParams[0]?.includes(25));
}
console.log("ok - market sorts rank projected candidates without rejoining");

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [
      [{ ids: ["market-1", "market-2"], pm_prefix_count: 2 }],
      [{ id: "market-1" }],
      [],
    ],
  });

  await fetchFeedMarketsDirect(pool, {
    ...baseInputs,
    limit: 1,
    eventScope: "grouped",
    sort: "totalvol",
  });

  assert.equal(capturedSql.length, 3);
  assert.match(
    capturedSql[0],
    /strict_market_base as materialized\s*\(\s*select candidate_market\.\*/i,
  );
  assert.match(
    capturedSql[0],
    /select candidate_market\.\*[\s\S]*?order by[\s\S]*?candidate_market\.volume_total[\s\S]*?limit \$\d+/i,
  );
  assert.ok(capturedParams[0]?.includes(300));
  assert.match(
    capturedSql[1],
    /selected_event_scope as materialized[\s\S]*?join lateral[\s\S]*?limit 2[\s\S]*?matched_event_scope\.market_count > 1/i,
  );
  assert.doesNotMatch(
    capturedSql[1],
    /selected_event_orderable_market_candidates/i,
  );
}
console.log("ok - grouped projected sorts rank a bounded strict prefix");

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [
      [{ ids: ["market-1"], pm_prefix_count: 1 }],
      [{ id: "market-1" }],
      [],
    ],
  });

  await fetchFeedMarketsDirect(pool, {
    ...baseInputs,
    durationMinutes: [60],
    eventScope: "grouped",
    filter: "newest",
    limit: 1,
    maxSpread: 0.1,
    minLiquidity: 1_000,
    sort: "totalvol",
    venues: ["polymarket"],
  });

  assert.equal(capturedSql.length, 3);
  assert.match(
    capturedSql[0],
    /projected_rank_event_candidates as materialized[\s\S]*?e\.start_date >= \$\d+[\s\S]*?orderable_market_candidates_strict_market_base as materialized/i,
  );
  assert.match(
    capturedSql[0],
    /strict_market_base as materialized[\s\S]*?join projected_rank_event_candidates candidate_event_filter[\s\S]*?m\.venue = ANY\(\$\d+::text\[\]\)[\s\S]*?m\.duration_minutes = ANY\(\$\d+::int\[\]\)[\s\S]*?\(m\.best_ask - m\.best_bid\) <= \$\d+[\s\S]*?order by/i,
  );
  assert.ok(capturedParams[0]?.includes(300));
}
console.log("ok - projected sorts push safe filters before bounded ranking");

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const phases: string[] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [
      [{ ids: ["market-1", "market-2"], pm_prefix_count: 300 }],
      [{ id: "market-1" }],
      [],
    ],
  });

  await fetchFeedMarketsDirect(
    pool,
    {
      ...baseInputs,
      eventScope: "grouped",
      filter: "newest",
      limit: 1,
      sort: undefined,
    },
    undefined,
    { onPhase: (phase) => phases.push(phase) },
  );

  assert.equal(capturedSql.length, 3);
  assert.match(
    capturedSql[0],
    /projected_rank_event_candidates as materialized[\s\S]*?e\.start_date >= \$\d+[\s\S]*?join projected_rank_event_candidates candidate_event_filter/i,
  );
  assert.match(
    capturedSql[0],
    /candidate_market\.event_start_date[\s\S]*?desc nulls last/i,
  );
  assert.ok(capturedParams[0]?.includes(300));
  assert.equal(capturedParams[0]?.includes(1_200), false);
  assert.match(
    capturedSql[1],
    /join lateral[\s\S]*?limit 2[\s\S]*?matched_event_scope\.market_count > 1/i,
  );
  assert.deepEqual(phases, ["market_rank_prefix", "market_scope_filter"]);
}
console.log("ok - newest scope stays bounded and reports rank/scope phases");

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const phases: string[] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [],
  });

  const rows = await fetchFeedMarketsDirect(
    pool,
    {
      ...baseInputs,
      eventScope: "grouped",
      sort: "trending_v2",
      sortDir: "asc",
    },
    undefined,
    { onPhase: (phase) => phases.push(phase) },
  );

  assert.deepEqual(rows, []);
  assert.equal(capturedSql.length, 0);
  assert.deepEqual(phases, ["market_rank_prefix"]);
}
console.log("ok - unsupported progressive ranks never fall into exact SQL");

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [
      [{ ids: ["market-1", "market-2"], pm_prefix_count: 0 }],
      [{ id: "market-1" }],
      [],
    ],
  });

  await fetchFeedMarketsDirect(pool, {
    ...baseInputs,
    categories: ["crypto"],
    eventScope: "grouped",
    limit: 1,
    sort: "totalvol",
  });

  assert.equal(capturedSql.length, 3);
  assert.ok(capturedParams[0]?.includes(1_200));
  assert.match(
    capturedSql[0],
    /projected_rank_event_candidates as materialized[\s\S]*?lower\(e\.category\) = ANY\(\$\d+::text\[\]\)[\s\S]*?join projected_rank_event_candidates candidate_event_filter/i,
  );
}
console.log("ok - projected category sorts rank only matching events");

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [
      [
        {
          ids: ["market-1", "market-2"],
          non_limitless_prefix_count: 300,
          non_limitless_valid_count: 2,
          limitless_candidate_count: 300,
          limitless_valid_count: 0,
          non_limitless_remainder_below_page: false,
          limitless_remainder_below_page: false,
        },
      ],
      [{ id: "market-1" }],
      [],
    ],
  });

  await fetchFeedMarketsDirect(pool, {
    ...baseInputs,
    limit: 1,
    eventScope: "grouped",
    sort: "trending_v2",
  });

  assert.equal(capturedSql.length, 3);
  assert.ok(capturedParams[0]?.includes(300));
  assert.equal(capturedParams[0]?.includes(6_000), false);
  assert.match(
    capturedSql[1],
    /selected_event_scope as materialized[\s\S]*?join lateral[\s\S]*?limit 2[\s\S]*?matched_event_scope\.market_count > 1/i,
  );
}
console.log("ok - grouped trending v2 keeps one bounded candidate prefix");

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [[{ ids: ["market-1", "market-2", "market-3"] }]],
  });

  const ids = await fetchFeedMarketIdsForProbabilityProbe(pool, {
    ...baseInputs,
    minProb: 0.4,
    maxProb: 0.6,
    sort: "trending",
  });

  assert.deepEqual(ids, {
    marketIds: ["market-1", "market-2", "market-3"],
    scannedCandidateCount: 3,
  });
  assert.equal(capturedSql.length, 1);
  assert.match(capturedSql[0], /ranked_market_page as materialized/i);
  assert.doesNotMatch(
    capturedSql[0],
    /canonical_token_mappings|unified_token_top_latest canonical_yes_top/i,
  );
}
console.log("ok - probability market probe ranks before canonical top mapping");

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [
      [{ id: "event-1" }, { id: "event-2" }],
      [
        { id: "market-1" },
        { id: "market-2" },
        { id: "market-3" },
        { id: "market-4" },
      ],
      [{ id: "market-2" }, { id: "market-3" }],
    ],
  });

  const ids = await fetchFeedMarketIdsForProbabilityProbe(pool, {
    ...baseInputs,
    limit: 2,
    offset: 1,
    category: "crypto",
    eventScope: "grouped",
    minProb: 0.4,
    maxProb: 0.6,
    sort: "trending",
  });

  assert.deepEqual(ids, {
    marketIds: ["market-2", "market-3"],
    scannedCandidateCount: 2,
  });
  assert.equal(capturedSql.length, 3);
  assert.match(
    capturedSql[0],
    /from unified_events candidate_event[\s\S]*?lower\(candidate_event\.category\) = any/i,
  );
  assert.ok(capturedParams[0]?.includes(5001));
  assert.match(
    capturedSql[1],
    /from unnest\(\$1::text\[\]\) candidate_event\(event_id\)[\s\S]*?join lateral/i,
  );
  assert.ok(capturedParams[1]?.includes(20_001));
  assert.match(
    capturedSql[2],
    /join unnest\(\$\d+::text\[\]\) as candidate_filter\(market_id\)/i,
  );
  assert.match(
    capturedSql[2],
    /scoped_orderable_market_candidates as materialized[\s\S]*?market_count > 1/i,
  );
  assert.match(capturedSql[2], /lower\(e\.category\) = \$\d+/i);
}
console.log(
  "ok - probability category scope ranks an exact indexed candidate set",
);

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const rankedIds = Array.from(
    { length: 1200 },
    (_, index) => `ranked-market-${index}`,
  );
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [
      [{ ids: rankedIds, pm_prefix_count: 0 }],
      [{ id: "ranked-market-1199" }],
      [{ id: "category-event-1" }],
      [{ id: "category-market-1" }, { id: "category-market-2" }],
      [{ id: "category-market-1" }, { id: "category-market-2" }],
      [],
    ],
  });

  await fetchFeedMarketsDirect(pool, {
    ...baseInputs,
    limit: 3,
    categories: ["crypto"],
    eventScope: "single",
    sort: "time",
  });

  assert.equal(capturedSql.length, 6);
  assert.ok(capturedParams[0]?.includes(1200));
  assert.equal(
    capturedParams.some((params) => params.includes(4800)),
    false,
  );
  assert.doesNotMatch(capturedSql[0], /lower\(e\.category\)/i);
  assert.match(capturedSql[1], /matched_event_scope\.market_count = 1/i);
  assert.match(capturedSql[1], /lower\(candidate_event\.category\) = any/i);
  assert.match(capturedSql[2], /from unified_events candidate_event/i);
  assert.ok(capturedParams[2]?.includes(5001));
  assert.match(capturedSql[3], /join lateral/i);
  assert.ok(capturedParams[3]?.includes(20_001));
  assert.match(
    capturedSql[4],
    /join unnest\(\$\d+::text\[\]\) as candidate_filter\(market_id\)/i,
  );
}
console.log("ok - sparse category pages fall back to exact indexed candidates");

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const rankedIds = Array.from(
    { length: 1200 },
    (_, index) => `broad-ranked-market-${index}`,
  );
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [
      [{ ids: rankedIds, pm_prefix_count: 0 }],
      [{ id: "broad-ranked-market-1199" }],
      Array.from({ length: 5001 }, (_, index) => ({
        id: `broad-category-event-${index}`,
      })),
      [],
    ],
  });

  await fetchFeedMarketsDirect(pool, {
    ...baseInputs,
    categories: ["sports"],
    eventScope: "single",
    sort: "time",
  });

  assert.equal(capturedSql.length, 4);
  assert.match(capturedSql[2], /from unified_events candidate_event/i);
  assert.ok(capturedParams[2]?.includes(5001));
  assert.equal(
    capturedSql.some((sql) => /category_market[\s\S]*?join lateral/i.test(sql)),
    false,
  );
}
console.log("ok - broad categories stop before exact market enumeration");

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const rankedIds = Array.from(
    { length: 1200 },
    (_, index) => `sports-ranked-market-${index}`,
  );
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [
      Array.from({ length: 5001 }, (_, index) => ({
        id: `sports-event-${index}`,
      })),
      [{ ids: rankedIds, pm_prefix_count: 0 }],
      [{ id: "sports-ranked-market-7" }],
    ],
  });

  const ids = await fetchFeedMarketIdsForProbabilityProbe(pool, {
    ...baseInputs,
    limit: 1200,
    categories: ["sports"],
    minProb: 0.4,
    maxProb: 0.6,
    sort: "trending",
  });

  assert.deepEqual(ids, {
    marketIds: ["sports-ranked-market-7"],
    scannedCandidateCount: 0,
  });
  assert.equal(capturedSql.length, 3);
  assert.match(capturedSql[0], /from unified_events candidate_event/i);
  assert.match(capturedSql[1], /ranked_market_page as materialized/i);
  assert.match(capturedSql[2], /selected_market_candidates as materialized/i);
}
console.log("ok - broad probability categories stop after one rank window");

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [[{ market_uuid: "market-search-1" }]],
  });

  const ids = await fetchFeedMarketIdsForProbabilityProbe(pool, {
    ...baseInputs,
    minProb: 0.4,
    maxProb: 0.6,
    q: "needle",
    sort: "trending",
  });

  assert.deepEqual(ids, {
    marketIds: ["market-search-1"],
    scannedCandidateCount: 1,
  });
  assert.equal(capturedSql.length, 1);
  assert.match(capturedSql[0], /primary_search_events as materialized/i);
  assert.doesNotMatch(capturedSql[0], /canonical_token_mappings/i);
}
console.log("ok - unsupported market ranks use a bounded candidate fallback");

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [
      [{ ids: [], pm_prefix_count: 100 }],
      [{ ids: ["market-1"], pm_prefix_count: 101 }],
      [],
    ],
  });

  await fetchFeedMarketsDirect(pool, {
    ...baseInputs,
    limit: 1,
    sort: "trending",
  });

  assert.equal(capturedSql.length, 3);
  assert.ok(capturedParams[0]?.includes(100));
  assert.ok(capturedParams[1]?.includes(400));
}
console.log("ok - market sort expands an exhausted Polymarket grace prefix");

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [[{ id: "market-2" }, { id: "market-1" }], []],
  });

  await fetchFeedMarketsDirect(pool, {
    ...baseInputs,
    marketIds: ["market-1", "market-2", "market-3"],
    eventScope: "grouped",
    maxSpread: 0.1,
    sort: "trending",
  });

  assert.equal(capturedSql.length, 2);
  assert.match(
    capturedSql[0],
    /join unnest\(\$\d+::text\[\]\) as candidate_filter\(market_id\)/i,
  );
  assert.match(
    capturedSql[0],
    /scoped_orderable_market_candidates as materialized[\s\S]*?count\(\*\) over \(partition by omc\.event_id\)[\s\S]*?market_count > 1/i,
  );
  assert.match(capturedSql[0], /m\.best_ask - m\.best_bid\) <= \$\d+/i);
  assert.match(capturedSql[0], /limit \$\d+ offset \$\d+/i);
  assert.match(
    capturedSql[1],
    /market_candidates as materialized[\s\S]*?from unnest\(\$\d+::text\[\]\)[\s\S]*?with ordinality selected\(id, ord\)/i,
  );
  assert.deepEqual(capturedParams[0]?.[2], [
    "market-1",
    "market-2",
    "market-3",
  ]);
}
console.log("ok - probability market ids are ranked before page hydration");

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [
      [{ id: "market-1" }, { id: "market-2" }, { id: "market-3" }],
      [],
    ],
  });

  await fetchFeedMarketsDirect(pool, {
    ...baseInputs,
    marketIds: ["market-1", "market-2"],
    sort: "change24h",
  });

  assert.match(
    capturedSql[0],
    /join unified_market_change_24h cached_change[\s\S]*?cached_change\.calculation_version = 2[\s\S]*?cached_change\.change_24h is not null/i,
  );
  assert.match(capturedSql[0], /order by cached_change\.change_24h desc/i);
  assert.match(
    capturedSql[1],
    /left join unified_market_change_24h cached_change[\s\S]*?cached_change\.calculation_version = 2/i,
  );
  assert.doesNotMatch(capturedSql[1], /observed_market_change_24h/i);
}
console.log("ok - probability change24h ranks and hydrates from the v2 cache");

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [[]],
  });

  const rows = await fetchFeedMarketsDirect(pool, {
    ...baseInputs,
    ageSince: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    sort: "change24h",
  });

  assert.deepEqual(rows, []);
  assert.equal(capturedSql.length, 1);
  assert.match(
    capturedSql[0],
    /lifecycle_change_candidates as materialized[\s\S]*?from unified_market_change_24h cached_change[\s\S]*?from lifecycle_change_candidates cached_candidate[\s\S]*?join lateral[\s\S]*?from unified_markets candidate_market[\s\S]*?join unified_events candidate_event/i,
  );
  assert.match(
    capturedSql[0],
    /candidate_event\.start_date is not null and candidate_event\.start_date >= \$\d+::timestamptz/i,
  );
  assert.doesNotMatch(capturedSql[0], /observed_market_change_24h/i);
}
console.log("ok - change24h age filters stop after exact lifecycle prefilter");

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [
      [{ id: "market-1" }, { id: "market-2" }],
      [{ id: "market-1" }, { id: "market-2" }],
      [],
    ],
  });

  await fetchFeedMarketsDirect(pool, {
    ...baseInputs,
    limit: 1,
    endWithin: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    eventScope: "grouped",
    sort: "change24h",
  });

  assert.equal(capturedSql.length, 3);
  assert.match(
    capturedSql[0],
    /candidate_event\.end_date is not null[\s\S]*?candidate_event\.end_date <= \$\d+::timestamptz/i,
  );
  assert.match(
    capturedSql[0],
    /lifecycle_change_candidates as materialized[\s\S]*?lifecycle_strict_candidates as materialized[\s\S]*?lifecycle_grace_candidates as materialized[\s\S]*?order by orderable_candidate\.change_24h desc/i,
  );
  assert.match(
    capturedSql[1],
    /selected_event_scope as materialized[\s\S]*?join lateral[\s\S]*?limit 2[\s\S]*?matched_event_scope\.market_count > 1/i,
  );
  assert.match(
    capturedSql[2],
    /left join unified_market_change_24h cached_change[\s\S]*?cached_change\.calculation_version = 2/i,
  );
}
console.log("ok - grouped change24h reuses exact lifecycle candidates");

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [
      Array.from({ length: 1000 }, (_, index) => ({
        id: `ranked-market-${index}`,
      })),
      [{ id: "market-1" }, { id: "market-2" }, { id: "market-3" }],
      [],
    ],
  });

  await fetchFeedMarketsDirect(pool, {
    ...baseInputs,
    eventScope: "grouped",
    maxSpread: 0.1,
    sort: "change24h",
  });

  assert.equal(capturedSql.length, 3);
  assert.match(
    capturedSql[0],
    /change24h_v2_ranked_market_candidates as materialized[\s\S]*?from unified_market_change_24h cache/i,
  );
  assert.doesNotMatch(capturedSql[0], /change24h_v2_candidate_event_scope/i);
  assert.match(
    capturedSql[1],
    /selected_event_scope as materialized[\s\S]*?join lateral[\s\S]*?limit 2[\s\S]*?matched_event_scope\.market_count > 1/i,
  );
  assert.match(capturedSql[0], /m\.best_ask - m\.best_bid\) <= \$\d+/i);
  assert.match(
    capturedSql[2],
    /left join unified_market_change_24h cached_change[\s\S]*?cached_change\.calculation_version = 2/i,
  );
}
console.log("ok - grouped change24h filters a bounded cache-ranked prefix");

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [[{ ids: ["event-1"], candidate_count: 1 }]],
  });

  const rows = await fetchFeedEventIds(pool, {
    ...baseInputs,
    limit: 1,
    view: "events",
    marketIds: ["market-1", "market-2"],
    minLiquidity: 1_000,
    maxSpread: 0.1,
    durationMinutes: [60],
    sort: "change24h",
  });

  assert.deepEqual(rows, [{ id: "event-1", cached_change_24h: true }]);
  assert.equal(capturedSql.length, 1);
  assert.match(
    capturedSql[0],
    /selected_market_ids as materialized[\s\S]*?from unnest\(\$\d+::text\[\]\)/i,
  );
  assert.match(
    capturedSql[0],
    /from unified_event_change_24h cache[\s\S]*?cache\.calculation_version = 2/i,
  );
  assert.match(
    capturedSql[0],
    /om\.id in \(select market_id from selected_market_ids\)/i,
  );
  assert.match(
    capturedSql[0],
    /coalesce\(nullif\(om\.liquidity, 0\), nullif\(om\.open_interest, 0\)\) >= \$\d+/i,
  );
  assert.match(capturedSql[0], /\(om\.best_ask - om\.best_bid\) <= \$\d+/i);
  assert.match(capturedSql[0], /om\.duration_minutes = ANY\(\$\d+::int\[\]\)/i);
}
console.log("ok - change24h event filters stay on the cached candidate path");

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [[{ ids: ["event-1"], candidate_count: 1 }]],
  });

  await fetchFeedEventIds(pool, {
    ...baseInputs,
    limit: 1,
    view: "events",
    minVol: 1_000,
    sort: "change24h",
  });

  assert.equal(capturedSql.length, 1);
  assert.match(
    capturedSql[0],
    /coalesce\([\s\S]*?fallback_volume_market[\s\S]*?\) >= \$\d+/i,
  );
}
console.log("ok - change24h event volume uses the exact fallback sum");

for (const sort of [
  "trending_v2",
  "totalvol",
  "liquidity",
  "openinterest",
  "time",
] as const) {
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [
      [
        {
          ids: ["event-1", "event-2", "event-3"],
          candidate_count: 3,
        },
      ],
    ],
  });

  const rows = await fetchFeedEventIds(pool, {
    ...baseInputs,
    view: "events",
    sort,
    maxSpread: 0.1,
  });

  assert.deepEqual(rows, [
    { id: "event-1" },
    { id: "event-2" },
    { id: "event-3" },
  ]);
  assert.equal(capturedSql.length, 1);
  assert.match(capturedSql[0], /ranked_event_candidates as materialized/i);
  assert.match(capturedSql[0], /valid_ranked_events as materialized/i);
  assert.equal(
    capturedSql[0]?.match(/\(om\.best_ask - om\.best_bid\) <= \$\d+/g)?.length,
    2,
    `${sort} max spread must constrain both orderable market branches`,
  );
  assert.doesNotMatch(
    capturedSql[0],
    /orderable_market_candidates as materialized/i,
  );
  assert.ok(capturedParams[0]?.includes(0.1));
}
console.log("ok - event spread sorts use ranked candidates");

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [[{ ids: ["event-1"], candidate_count: 1 }]],
  });

  const rows = await fetchFeedEventIds(pool, {
    ...baseInputs,
    limit: 1,
    view: "events",
    eventScope: "grouped",
    sort: "totalvol",
    maxSpread: 0.1,
  });

  assert.deepEqual(rows, [{ id: "event-1" }]);
  assert.equal(capturedSql.length, 1);
  assert.match(capturedSql[0], /ranked_event_candidates as materialized/i);
  assert.match(
    capturedSql[0],
    /ranked_event_orderable_market_candidates_strict_market_base as materialized[\s\S]*?join ranked_event_candidates candidate_event_filter/i,
  );
  assert.match(
    capturedSql[0],
    /ranked_event_scope as materialized[\s\S]*?having count\(\*\) > 1/i,
  );
  assert.match(
    capturedSql[0],
    /join ranked_event_scope matched_event_scope[\s\S]*?on matched_event_scope\.event_id = c\.id/i,
  );
  assert.equal(
    capturedSql[0]?.match(/\(om\.best_ask - om\.best_bid\) <= \$\d+/g)?.length,
    2,
  );
}
console.log("ok - grouped event spread scopes only ranked candidates");

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [[{ ids: ["event-1"], candidate_count: 1 }]],
  });

  const rows = await fetchFeedEventIds(
    pool,
    {
      ...baseInputs,
      limit: 5,
      view: "events",
      sort: "trending_v2",
    },
    { acceptPartialMetricPage: true },
  );

  assert.deepEqual(rows, [{ id: "event-1" }]);
  assert.equal(capturedSql.length, 1);
  assert.doesNotMatch(
    capturedSql[0],
    /orderable_market_candidates as materialized/i,
  );
}
console.log("ok - bounded trending v2 probes keep exhausted partial results");

{
  const capturedSql: string[] = [];
  const capturedParams: unknown[][] = [];
  const pool = createCapturePool({
    capturedSql,
    capturedParams,
    candidateRows: [
      [
        {
          ids: ["event-1"],
          candidate_count: 2_400,
        },
      ],
    ],
  });

  const rows = await fetchFeedEventIds(
    pool,
    {
      ...baseInputs,
      limit: 1_200,
      view: "events",
      sort: "totalvol",
    },
    { acceptPartialMetricPage: true },
  );

  assert.deepEqual(rows, [{ id: "event-1" }]);
  assert.equal(capturedSql.length, 1);
  assert.ok(capturedParams[0]?.includes(2_400));
  assert.equal(capturedParams[0]?.includes(24_000), false);
}
console.log("ok - bounded event probes do not expand past their page target");
