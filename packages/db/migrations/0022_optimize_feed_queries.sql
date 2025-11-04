-- Optimize feed queries with composite indexes
-- This migration adds composite indexes specifically for the /feed endpoint query patterns

-- Composite index for events: status + venue + category (for filtering)
CREATE INDEX IF NOT EXISTS idx_unified_events_status_venue_category 
ON unified_events(status, venue, lower(category)) 
WHERE status = 'ACTIVE' AND category IS NOT NULL;

-- Composite index for events: status + venue (for venue filtering)
CREATE INDEX IF NOT EXISTS idx_unified_events_status_venue 
ON unified_events(status, venue) 
WHERE status = 'ACTIVE';

-- Composite index for markets: status + event_id + volume_24h + liquidity (for filtering and joining)
CREATE INDEX IF NOT EXISTS idx_unified_markets_active_event_volume_liquidity 
ON unified_markets(status, event_id, volume_24h DESC NULLS LAST, liquidity DESC NULLS LAST) 
WHERE status = 'ACTIVE';

-- Composite index for markets: status + expiration_time + close_time (for time-based filtering)
CREATE INDEX IF NOT EXISTS idx_unified_markets_active_time_filters 
ON unified_markets(status, expiration_time, close_time) 
WHERE status = 'ACTIVE';

-- Composite index for events: status + start_date (for newest filter)
CREATE INDEX IF NOT EXISTS idx_unified_events_active_start_date 
ON unified_events(status, start_date DESC NULLS LAST) 
WHERE status = 'ACTIVE' AND start_date IS NOT NULL;

-- Composite index for events: status + end_date (for ending soon filter)
CREATE INDEX IF NOT EXISTS idx_unified_events_active_end_date_asc 
ON unified_events(status, end_date ASC NULLS LAST) 
WHERE status = 'ACTIVE' AND end_date IS NOT NULL;

-- Composite index for markets: status + event_id + volume_24h (for volume filtering)
CREATE INDEX IF NOT EXISTS idx_unified_markets_active_event_volume 
ON unified_markets(status, event_id, volume_24h DESC NULLS LAST) 
WHERE status = 'ACTIVE';

-- Composite index for markets: status + event_id + liquidity (for liquidity filtering)
CREATE INDEX IF NOT EXISTS idx_unified_markets_active_event_liquidity 
ON unified_markets(status, event_id, liquidity DESC NULLS LAST) 
WHERE status = 'ACTIVE';

-- Index for event_id lookups (for the second query)
CREATE INDEX IF NOT EXISTS idx_unified_markets_event_id_active 
ON unified_markets(event_id, status) 
WHERE status = 'ACTIVE';

