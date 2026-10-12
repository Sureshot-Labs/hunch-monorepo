/* no-transaction */
-- Existing ledger can be large. Do not hold a write-blocking index build lock.
CREATE INDEX CONCURRENTLY IF NOT EXISTS hip4_trades_cursor_idx
  ON hip4_public_trades(market_id,time_ms DESC,coin DESC,tid DESC);
