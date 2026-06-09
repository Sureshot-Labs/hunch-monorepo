/* no-transaction */
SET lock_timeout = '5s';
SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_polymarket_markets_ws_top_tokens
  ON polymarket_markets (
    (coalesce(volume24hr_clob, 0::numeric)) DESC,
    (coalesce(liquidity_clob, 0::numeric)) DESC,
    (coalesce(volume24hr, 0::numeric)) DESC,
    (coalesce(liquidity, 0::numeric)) DESC,
    id
  )
  INCLUDE (clob_token_ids)
  WHERE closed = false
    AND archived = false
    AND enable_order_book = true
    AND accepting_orders = true
    AND clob_token_ids IS NOT NULL
    AND clob_token_ids <> '[]';
