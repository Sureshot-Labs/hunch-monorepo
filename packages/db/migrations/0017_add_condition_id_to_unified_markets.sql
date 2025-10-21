-- Add condition_id column to unified_markets table
-- This migration adds the condition_id field to support CLOB and resolution ties

ALTER TABLE unified_markets ADD COLUMN condition_id text;

-- Add index for performance
CREATE INDEX IF NOT EXISTS idx_unified_markets_condition_id ON unified_markets(condition_id);
