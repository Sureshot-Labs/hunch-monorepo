/* no-transaction */

SET statement_timeout = 0;
SET lock_timeout = '5s';

-- Read-only production catalog, query-shape, and source-consumer audit on
-- 2026-08-29 confirmed that these ordinary-table indexes are not required by
-- constraints and are either unused or superseded by an existing active index.
-- Keep every drop concurrent and idempotent: if a lock timeout interrupts a
-- manual run, rerunning the migration safely resumes at the remaining indexes.

-- Replaced analytics left-prefix indexes.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_analytics_server_events_event_name;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_analytics_server_events_user_created_at;

-- Limitless source tables: current consumers use PK/event joins and the market
-- expiration retention index, not these generic scalar indexes.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_limitless_events_created_at;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_limitless_events_expiration_timestamp;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_limitless_events_expired;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_limitless_events_market_type;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_limitless_events_status;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_limitless_events_volume_total;

DROP INDEX CONCURRENTLY IF EXISTS public.idx_limitless_markets_created_at;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_limitless_markets_expired;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_limitless_markets_market_type;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_limitless_markets_status;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_limitless_markets_volume_total;

-- Polymarket source events retain their PK and end-date retention index.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_polymarket_events_active;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_polymarket_events_category;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_polymarket_events_closed;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_polymarket_events_liquidity;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_polymarket_events_volume;

-- The version-2 partial rank indexes are the active change24 feed paths.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_event_change_24h_change;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_market_change_24h_change;

-- Unified event feed paths now use bounded candidate streams, normalized
-- category indexes, compact metric ranks, and the venue/event unique index.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_events_active_category;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_events_active_duration_end;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_events_active_end_date_asc;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_events_active_volume24h;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_events_category;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_events_liquidity;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_events_lower_venue_status_end_date;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_events_open_interest;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_events_status_active;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_events_status_venue;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_events_status_venue_category;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_events_venue;

-- Superseded or unused unified-market selectors. Retention/status/Kalshi audit
-- indexes are deliberately retained.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_markets_lower_venue_status_exp_close;

-- Token lookups are market/token scoped. Venue-only and side-only scans were
-- absent from production statistics.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_tokens_side;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_unified_tokens_venue;

RESET lock_timeout;
RESET statement_timeout;
