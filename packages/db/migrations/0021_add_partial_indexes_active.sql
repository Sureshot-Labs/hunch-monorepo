-- Add partial indexes for ACTIVE status to dramatically improve query performance
-- These indexes only include ACTIVE records, making them much smaller and faster
-- This is critical since we now store all closed/settled markets in the database

-- Partial index for ACTIVE events only (much smaller than full status index)
CREATE INDEX IF NOT EXISTS idx_unified_events_status_active 
ON unified_events(status) 
WHERE status = 'ACTIVE';

-- Partial index for ACTIVE markets only (much smaller than full status index)
CREATE INDEX IF NOT EXISTS idx_unified_markets_status_active 
ON unified_markets(status) 
WHERE status = 'ACTIVE';

-- Composite partial indexes for common query patterns
-- Events: status + volume_24h (for trending/sorting)
CREATE INDEX IF NOT EXISTS idx_unified_events_active_volume24h 
ON unified_events(volume_24h DESC NULLS LAST) 
WHERE status = 'ACTIVE';

-- Markets: status + event_id (for joining active markets to events)
CREATE INDEX IF NOT EXISTS idx_unified_markets_active_event_id 
ON unified_markets(event_id) 
WHERE status = 'ACTIVE';

-- Markets: status + volume_24h (for filtering and sorting)
CREATE INDEX IF NOT EXISTS idx_unified_markets_active_volume24h 
ON unified_markets(volume_24h DESC NULLS LAST) 
WHERE status = 'ACTIVE';

-- Markets: status + liquidity (for filtering and sorting)
CREATE INDEX IF NOT EXISTS idx_unified_markets_active_liquidity 
ON unified_markets(liquidity DESC NULLS LAST) 
WHERE status = 'ACTIVE';

-- Markets: status + expiration_time (for time-based filtering)
CREATE INDEX IF NOT EXISTS idx_unified_markets_active_expiration 
ON unified_markets(expiration_time) 
WHERE status = 'ACTIVE' AND expiration_time IS NOT NULL;

-- Markets: status + close_time (for time-based filtering)
CREATE INDEX IF NOT EXISTS idx_unified_markets_active_close_time 
ON unified_markets(close_time) 
WHERE status = 'ACTIVE' AND close_time IS NOT NULL;

-- Events: status + end_date (for time-based filtering)
CREATE INDEX IF NOT EXISTS idx_unified_events_active_end_date 
ON unified_events(end_date) 
WHERE status = 'ACTIVE' AND end_date IS NOT NULL;

-- Composite index for status + category (for category filtering)
CREATE INDEX IF NOT EXISTS idx_unified_events_active_category 
ON unified_events(lower(category)) 
WHERE status = 'ACTIVE' AND category IS NOT NULL;

