-- Add category column to Polymarket venue-specific tables
-- This migration adds the category field to support storing API-provided categories

-- Add category to polymarket_events table
ALTER TABLE polymarket_events
ADD COLUMN IF NOT EXISTS category text;

-- Add category to polymarket_markets table
ALTER TABLE polymarket_markets
ADD COLUMN IF NOT EXISTS category text;

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_polymarket_events_category ON polymarket_events(category);
CREATE INDEX IF NOT EXISTS idx_polymarket_markets_category ON polymarket_markets(category);

