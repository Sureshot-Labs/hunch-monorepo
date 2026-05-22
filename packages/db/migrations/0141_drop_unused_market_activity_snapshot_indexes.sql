/* no-transaction */

SET statement_timeout = 0;

-- Event-level activity snapshots are the served sparkline source now. These
-- market snapshot indexes only supported obsolete/unused fallback read paths,
-- while every current-bucket snapshot upsert still paid to maintain them.
DROP INDEX CONCURRENTLY IF EXISTS idx_um_activity_snapshots_event_venue_bucket_market;
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_market_activity_snapshots_event_bucket;
DROP INDEX CONCURRENTLY IF EXISTS idx_unified_market_activity_snapshots_venue_bucket;
