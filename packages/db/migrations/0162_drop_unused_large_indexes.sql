/* no-transaction */

SET statement_timeout = 0;

-- Drop large indexes that are not matched by current runtime query shapes.
-- Keep venue/token lookups and market metric indexes that are still reachable
-- through fee resolution, representative-market selection, feed sorting, or
-- wallet-intel market selection.
DROP INDEX CONCURRENTLY IF EXISTS idx_wallet_position_snapshots_wallet_market_time_pos;
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_token_top_latest_ts;

DROP INDEX CONCURRENTLY IF EXISTS idx_unified_markets_active_event_volume;
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_markets_active_event_liquidity;

DROP INDEX CONCURRENTLY IF EXISTS idx_unified_markets_best_bid;
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_markets_best_ask;

-- Redundant with unified_tokens.token_id primary key.
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_tokens_token_id;
