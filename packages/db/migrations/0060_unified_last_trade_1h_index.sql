/* no-transaction */
SET statement_timeout = 0;

CREATE INDEX IF NOT EXISTS idx_unified_last_trade_1h_token_bucket
  ON unified_last_trade_1h (token_id, bucket DESC);
