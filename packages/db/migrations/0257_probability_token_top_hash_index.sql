-- Probability discovery probes thousands of canonical token IDs, most of
-- which have no observed book. The wide text primary key is expensive to
-- read cold. A compact equality-only index keeps these negative lookups
-- cacheable. PostgreSQL still rechecks the exact token ID on hash collisions.
-- Retain the B-tree primary key for uniqueness and ON CONFLICT writes.
-- Deploy migrates while the old application writers remain online.
-- Rebuild only this new, non-unique index on retry: a cancelled concurrent
-- build can leave an invalid index which CREATE IF NOT EXISTS would skip.
/* no-transaction */
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_token_top_latest_token_hash;
CREATE INDEX CONCURRENTLY idx_unified_token_top_latest_token_hash
  ON unified_token_top_latest USING hash (token_id);
