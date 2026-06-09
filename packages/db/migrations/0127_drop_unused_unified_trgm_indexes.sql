/* no-transaction */
SET lock_timeout = '5s';
SET statement_timeout = 0;

DROP INDEX CONCURRENTLY IF EXISTS idx_unified_events_title_trgm;
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_events_description_trgm;
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_events_category_trgm;
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_events_slug_trgm;

DROP INDEX CONCURRENTLY IF EXISTS idx_unified_markets_title_trgm;
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_markets_description_trgm;
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_markets_category_trgm;
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_markets_slug_trgm;
