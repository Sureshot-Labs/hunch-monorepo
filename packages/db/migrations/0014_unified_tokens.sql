-- Unified tokens table migration
-- This migration creates a unified tokens table to replace the legacy tokens table
-- The tokens table is needed for orderbook functionality across all venues

-- Unified tokens table - stores token mappings for all venues
CREATE TABLE IF NOT EXISTS unified_tokens (
  token_id text PRIMARY KEY,                         -- e.g. clobTokenIds[0], kalshi:ticker:YES
  venue text NOT NULL,                               -- 'polymarket', 'kalshi', 'limitless'
  market_id text NOT NULL,                           -- References unified_markets.id
  side text CHECK (side IN ('YES','NO')) NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  
  -- Composite unique constraint to prevent duplicate tokens per market/side
  CONSTRAINT unique_market_side UNIQUE (market_id, side)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_unified_tokens_venue ON unified_tokens(venue);
CREATE INDEX IF NOT EXISTS idx_unified_tokens_market_id ON unified_tokens(market_id);
CREATE INDEX IF NOT EXISTS idx_unified_tokens_side ON unified_tokens(side);

-- Add comments for documentation
COMMENT ON TABLE unified_tokens IS 'Unified tokens table for token mappings across all venues';
COMMENT ON COLUMN unified_tokens.token_id IS 'Token identifier (format varies by venue)';
COMMENT ON COLUMN unified_tokens.venue IS 'Source venue: polymarket, kalshi, or limitless';
COMMENT ON COLUMN unified_tokens.market_id IS 'Reference to unified_markets.id';
COMMENT ON COLUMN unified_tokens.side IS 'Token side: YES or NO';
