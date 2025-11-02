-- Add image and icon columns to unified tables
-- These fields are provided by Polymarket's Gamma API for events and markets

-- Add image and icon to unified_events table
ALTER TABLE unified_events
ADD COLUMN IF NOT EXISTS image text,
ADD COLUMN IF NOT EXISTS icon text;

-- Add image and icon to unified_markets table
ALTER TABLE unified_markets
ADD COLUMN IF NOT EXISTS image text,
ADD COLUMN IF NOT EXISTS icon text;

