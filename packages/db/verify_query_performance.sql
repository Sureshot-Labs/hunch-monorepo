-- Script to verify query performance improvements
-- Run this after applying migration 0022_optimize_feed_queries.sql
-- This will show you the query execution plan and timing

-- First, let's check if indexes were created
SELECT 
    schemaname,
    tablename,
    indexname,
    indexdef
FROM pg_indexes
WHERE tablename IN ('unified_events', 'unified_markets')
    AND indexname LIKE 'idx_unified_%'
ORDER BY tablename, indexname;

-- Example query execution plan (simulating the /feed endpoint)
-- Replace the parameters with actual values from your environment
EXPLAIN ANALYZE
SELECT
    e.id,
    sum(coalesce(m.volume_24h, 0)) as total_volume,
    sum(coalesce(m.liquidity, 0)) as total_liquidity,
    e.start_date,
    e.end_date
FROM unified_events e
JOIN unified_markets m ON m.event_id = e.id
    AND m.status = 'ACTIVE'
    AND (m.expiration_time IS NULL OR m.expiration_time > NOW())
    AND (m.close_time IS NULL OR m.close_time > NOW())
WHERE e.status = 'ACTIVE'
    AND (e.end_date IS NULL OR e.end_date > NOW())
GROUP BY e.id, e.start_date, e.end_date
HAVING sum(coalesce(m.volume_24h, 0)) >= 0
    AND sum(coalesce(m.liquidity, 0)) >= 0
ORDER BY e.start_date DESC NULLS LAST, e.id
LIMIT 50 OFFSET 0;

-- Check index usage statistics
SELECT 
    schemaname,
    tablename,
    indexname,
    idx_scan as index_scans,
    idx_tup_read as tuples_read,
    idx_tup_fetch as tuples_fetched
FROM pg_stat_user_indexes
WHERE tablename IN ('unified_events', 'unified_markets')
    AND indexname LIKE 'idx_unified_%'
ORDER BY idx_scan DESC;

