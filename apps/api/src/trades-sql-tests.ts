#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  COUNT_TRADES_BY_TOKEN_SQL,
  MAX_TRADES_QUERY_WORK,
  MAX_TRADES_TOKEN_IDS,
  RECENT_TRADES_BY_TOKEN_SQL,
  RESOLVE_TRADES_TOKEN_IDS_LIMIT,
  TRADES_DB_STATEMENT_TIMEOUT_MS,
  tradesQueryWork,
} from "./routes/trades.js";
import { tradesQuerySchema } from "./schemas/trades.js";

assert.match(RECENT_TRADES_BY_TOKEN_SQL, /cross join lateral/iu);
assert.match(
  RECENT_TRADES_BY_TOKEN_SQL,
  /where token_trade\.token_id\s*=\s*requested_tokens\.token_id/iu,
);
assert.match(
  RECENT_TRADES_BY_TOKEN_SQL,
  /order by token_trade\.ts desc\s+limit \$4/iu,
);
assert.doesNotMatch(RECENT_TRADES_BY_TOKEN_SQL, /where token_id\s*=\s*any\(/iu);
assert.match(COUNT_TRADES_BY_TOKEN_SQL, /cross join lateral/iu);
assert.match(COUNT_TRADES_BY_TOKEN_SQL, /count\(\*\)::bigint/iu);
assert.doesNotMatch(COUNT_TRADES_BY_TOKEN_SQL, /count_capped/iu);
assert.equal(RESOLVE_TRADES_TOKEN_IDS_LIMIT, MAX_TRADES_TOKEN_IDS + 1);
assert.equal(TRADES_DB_STATEMENT_TIMEOUT_MS, 1_500);
assert.equal(
  tradesQueryWork({ tokenCount: 2, limit: 200, offset: 10_000 }),
  20_400,
);
assert.ok(
  tradesQueryWork({
    tokenCount: MAX_TRADES_TOKEN_IDS,
    limit: 200,
    offset: 10_000,
  }) > MAX_TRADES_QUERY_WORK,
);
assert.equal(
  tradesQuerySchema.parse({ tokenIds: "token_a", offset: 10_001 }).offset,
  10_001,
);

console.log(
  "[trades-sql-tests] ok each token uses a bounded timestamp-index walk before the global merge",
);
