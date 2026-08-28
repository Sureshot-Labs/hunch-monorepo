#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";

import {
  type FeedInputs,
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
