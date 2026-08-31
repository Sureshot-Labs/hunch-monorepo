#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { POSITION_MARKET_JOIN_SQL } from "./repos/shares.js";

assert.match(
  POSITION_MARKET_JOIN_SQL,
  /select nullif\(m\.token_yes, ''\) as token_id, 0 as token_rank/iu,
);
assert.match(
  POSITION_MARKET_JOIN_SQL,
  /select nullif\(m\.token_no, ''\) as token_id, 0 as token_rank/iu,
);
assert.match(
  POSITION_MARKET_JOIN_SQL,
  /outcome_token\.market_id\s*=\s*m\.id/iu,
);
assert.doesNotMatch(
  POSITION_MARKET_JOIN_SQL,
  /top\.token_id\s*=\s*m\.token_(?:yes|no)\s+or/iu,
);
assert.match(POSITION_MARKET_JOIN_SQL, /candidate_token/iu);
assert.match(
  POSITION_MARKET_JOIN_SQL,
  /join unified_token_top_latest top\s+on top\.token_id = candidate_token\.token_id/iu,
);
assert.match(
  POSITION_MARKET_JOIN_SQL,
  /select outcome_token\.token_id, 1 as token_rank/iu,
);

console.log(
  "[shares-sql-tests] ok outcome top lookups use exact token indexes with bounded fallback",
);
