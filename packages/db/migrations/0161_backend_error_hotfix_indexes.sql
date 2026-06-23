/* no-transaction */
SET statement_timeout = 0;

-- Restores the raw trade access path needed by /trades:
-- where token_id = any($1) order by ts desc limit ...
-- unified_last_trade is a Timescale hypertable. Timescale rejects
-- CREATE INDEX CONCURRENTLY on hypertables.
CREATE INDEX IF NOT EXISTS idx_unified_last_trade_token_ts_desc
  ON unified_last_trade (token_id, ts DESC);

-- Keeps the default Kalshi mint-audit selector paginated by status/id from
-- scanning all Kalshi Solana markets that have already been audited.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_unified_markets_kalshi_mint_audit_pending
  ON unified_markets (status, id)
  WHERE venue = 'kalshi'
    AND (token_yes LIKE 'sol:%' OR token_no LIKE 'sol:%')
    AND NOT (coalesce(metadata, '{}'::jsonb) ? 'mint_exists');
