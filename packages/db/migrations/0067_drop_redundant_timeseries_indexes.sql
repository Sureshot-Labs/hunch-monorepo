/* no-transaction */
SET statement_timeout = 0;

-- Raw hypertable: PK (token_id, ts) already covers token+time lookups.
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_last_trade_recent;

-- Continuous aggregates: Timescale creates materialization indexes for grouped dimensions.
-- These legacy custom indexes are duplicates and add write amplification.
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_book_top_1m_token_bucket;
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_book_top_1m_venue_bucket;
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_last_trade_1m_token_bucket;
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_last_trade_1m_venue_bucket;

DROP INDEX CONCURRENTLY IF EXISTS idx_unified_book_top_1h_token_bucket;
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_book_top_1h_venue_bucket;
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_last_trade_1h_token_bucket;
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_last_trade_1h_venue_bucket;

DROP INDEX CONCURRENTLY IF EXISTS idx_unified_last_trade_24h_token_bucket;
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_last_trade_24h_venue_bucket;
