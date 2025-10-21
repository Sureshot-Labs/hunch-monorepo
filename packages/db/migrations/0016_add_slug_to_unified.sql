-- Add slug field to unified tables
-- This migration adds slug data to the unified tables for Polymarket and Limitless venues
-- Note: Kalshi does not provide slug data in their API

-- Add slug to unified_events table
ALTER TABLE unified_events 
ADD COLUMN IF NOT EXISTS slug text;

-- Add slug to unified_markets table  
ALTER TABLE unified_markets 
ADD COLUMN IF NOT EXISTS slug text;

-- Add index for slug queries
CREATE INDEX IF NOT EXISTS idx_unified_events_slug ON unified_events(slug);
CREATE INDEX IF NOT EXISTS idx_unified_markets_slug ON unified_markets(slug);
