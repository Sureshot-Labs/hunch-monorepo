-- Add open_interest field to unified tables
-- This migration adds open interest/wager data to the unified tables for Polymarket and Kalshi venues

-- Add open_interest to unified_events table
ALTER TABLE unified_events 
ADD COLUMN IF NOT EXISTS open_interest numeric;

-- Add open_interest to unified_markets table  
ALTER TABLE unified_markets 
ADD COLUMN IF NOT EXISTS open_interest numeric;

-- Add index for open_interest queries
CREATE INDEX IF NOT EXISTS idx_unified_events_open_interest ON unified_events(open_interest DESC);
CREATE INDEX IF NOT EXISTS idx_unified_markets_open_interest ON unified_markets(open_interest DESC);
