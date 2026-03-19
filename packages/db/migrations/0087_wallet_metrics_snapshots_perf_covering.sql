/* no-transaction */
SET lock_timeout = '5s';
SET statement_timeout = 0;

-- Speeds up per-wallet latest/earliest portfolio PnL lookups used by wallet
-- intel summary and hero stats, while avoiding broad scans of the full
-- snapshots table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_metrics_snapshots_all_pnl_wallet_asof
  ON wallet_metrics_snapshots (wallet_id, as_of DESC)
  INCLUDE (pnl_usd)
  WHERE period = 'all'
    AND pnl_usd IS NOT NULL;
