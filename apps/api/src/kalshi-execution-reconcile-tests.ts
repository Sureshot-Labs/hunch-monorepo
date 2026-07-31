#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";

import {
  fetchFulfilledKalshiTradeExecutionsMissingFeeEvent,
  fetchPendingKalshiExecutions,
} from "./repos/executions-repo.js";

const calls: Array<Readonly<{ sql: string; params: readonly unknown[] }>> = [];
const pool = {
  async query(sql: string, params: readonly unknown[]) {
    calls.push({ sql, params });
    return { rows: [] };
  },
} as unknown as Pool;

await fetchPendingKalshiExecutions(pool, {
  limit: 25,
  minAgeSec: 15,
});
await fetchFulfilledKalshiTradeExecutionsMissingFeeEvent(pool, {
  limit: 25,
  minAgeSec: 15,
  maxAgeSec: 604_800,
});

assert.equal(calls.length, 2);
const pendingCall = calls[0];
const feeBackfillCall = calls[1];
assert.ok(pendingCall);
assert.ok(feeBackfillCall);
assert.doesNotMatch(pendingCall.sql, /created_at >=/);
assert.match(pendingCall.sql, /limit \$2/);
assert.match(pendingCall.sql, /order by created_at asc/);
assert.deepEqual(pendingCall.params, [15, 25]);

assert.match(
  feeBackfillCall.sql,
  /created_at >= now\(\) - \(\$2::int \* interval '1 second'\)/,
);
assert.match(feeBackfillCall.sql, /limit \$3/);
assert.match(feeBackfillCall.sql, /order by e\.created_at asc/);
assert.deepEqual(feeBackfillCall.params, [15, 604_800, 25]);

calls.length = 0;
await assert.rejects(
  fetchPendingKalshiExecutions(pool, {
    limit: 1,
    minAgeSec: -1,
  }),
  /minAgeSec must be non-negative/,
);
await assert.rejects(
  fetchFulfilledKalshiTradeExecutionsMissingFeeEvent(pool, {
    limit: 1,
    minAgeSec: 60,
    maxAgeSec: 30,
  }),
  /fee backfill maxAgeSec must be greater than minAgeSec/,
);
assert.equal(calls.length, 0);

console.log("kalshi execution reconcile tests passed");
