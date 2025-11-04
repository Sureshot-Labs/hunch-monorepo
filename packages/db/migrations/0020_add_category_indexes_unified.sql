-- Add indexes for category filtering on unified tables
-- This migration adds functional indexes for case-insensitive category matching

-- Functional index for case-insensitive category matching on unified_events
CREATE INDEX IF NOT EXISTS idx_unified_events_category_lower ON unified_events(lower(category)) WHERE category IS NOT NULL;

-- Functional index for case-insensitive category matching on unified_markets
CREATE INDEX IF NOT EXISTS idx_unified_markets_category_lower ON unified_markets(lower(category)) WHERE category IS NOT NULL;

-- Regular index for exact category matching (if needed)
CREATE INDEX IF NOT EXISTS idx_unified_events_category ON unified_events(category) WHERE category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_unified_markets_category ON unified_markets(category) WHERE category IS NOT NULL;

