/* no-transaction */
SET lock_timeout = '5s';
SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wms_30d_wallet_asof_cover
  ON wallet_metrics_snapshots (wallet_id, as_of DESC)
  INCLUDE (
    volume_usd,
    pnl_usd,
    roi,
    trades_count,
    win_rate,
    avg_hold_hours,
    last_trade_at
  )
  WHERE period = '30d';
