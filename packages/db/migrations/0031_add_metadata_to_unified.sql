-- Add metadata JSONB columns to unified tables
-- Intended to store venue-specific fields that don't fit normalized schema.

ALTER TABLE unified_events
ADD COLUMN IF NOT EXISTS metadata jsonb;

ALTER TABLE unified_markets
ADD COLUMN IF NOT EXISTS metadata jsonb;

COMMENT ON COLUMN unified_events.metadata IS 'Venue-specific metadata (JSON)';
COMMENT ON COLUMN unified_markets.metadata IS 'Venue-specific metadata (JSON)';
