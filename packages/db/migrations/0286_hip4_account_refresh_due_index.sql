/* no-transaction */
-- Refresh fairness/due selection. No provider calls or data backfill.
CREATE INDEX CONCURRENTLY IF NOT EXISTS hip4_account_refresh_due_idx
  ON hip4_account_snapshots(environment, attempt_at ASC NULLS FIRST, account_address);
