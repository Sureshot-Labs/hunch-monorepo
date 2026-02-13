/* no-transaction */
SET statement_timeout = 0;

-- 0067 dropped unqualified names. The duplicate CAGG indexes live in
-- _timescaledb_internal, so we must drop schema-qualified index names.
DROP INDEX CONCURRENTLY IF EXISTS _timescaledb_internal.idx_unified_book_top_1m_token_bucket;
DROP INDEX CONCURRENTLY IF EXISTS _timescaledb_internal.idx_unified_book_top_1m_venue_bucket;
DROP INDEX CONCURRENTLY IF EXISTS _timescaledb_internal.idx_unified_book_top_1h_token_bucket;
DROP INDEX CONCURRENTLY IF EXISTS _timescaledb_internal.idx_unified_book_top_1h_venue_bucket;

DROP INDEX CONCURRENTLY IF EXISTS _timescaledb_internal.idx_unified_last_trade_1m_token_bucket;
DROP INDEX CONCURRENTLY IF EXISTS _timescaledb_internal.idx_unified_last_trade_1m_venue_bucket;
DROP INDEX CONCURRENTLY IF EXISTS _timescaledb_internal.idx_unified_last_trade_1h_token_bucket;
DROP INDEX CONCURRENTLY IF EXISTS _timescaledb_internal.idx_unified_last_trade_1h_venue_bucket;
DROP INDEX CONCURRENTLY IF EXISTS _timescaledb_internal.idx_unified_last_trade_24h_token_bucket;
DROP INDEX CONCURRENTLY IF EXISTS _timescaledb_internal.idx_unified_last_trade_24h_venue_bucket;
