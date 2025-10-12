-- Add token ID columns to unified_markets table
-- This migration adds token ID fields to support price history and orderbook queries

-- Add token ID columns for different venues
ALTER TABLE unified_markets 
ADD COLUMN IF NOT EXISTS token_yes text,
ADD COLUMN IF NOT EXISTS token_no text,
ADD COLUMN IF NOT EXISTS clob_token_ids text; -- JSON string for venues with multiple tokens

-- Add indexes for token lookups
CREATE INDEX IF NOT EXISTS idx_unified_markets_token_yes ON unified_markets(token_yes);
CREATE INDEX IF NOT EXISTS idx_unified_markets_token_no ON unified_markets(token_no);

-- Add comments for clarity
COMMENT ON COLUMN unified_markets.token_yes IS 'Token ID for YES outcome (used by Limitless, Kalshi)';
COMMENT ON COLUMN unified_markets.token_no IS 'Token ID for NO outcome (used by Limitless, Kalshi)';
COMMENT ON COLUMN unified_markets.clob_token_ids IS 'JSON array of token IDs (used by Polymarket)';
