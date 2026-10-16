/* no-transaction */
-- Cache state only. Durable source paging reuses the refresh pipeline owner and
-- the existing wallets(chain, lower(address)) index, not a new worker/table.
ALTER TABLE unified_refresh_pipeline_state
  ADD COLUMN IF NOT EXISTS source_cursor jsonb;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_follows_wallet_id
  ON wallet_follows(wallet_id);
