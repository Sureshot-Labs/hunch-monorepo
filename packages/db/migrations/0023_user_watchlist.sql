-- User Watchlist Migration
-- This migration adds a watchlist feature allowing users to save their favorite markets

-- User watchlist table - stores user-market relationships
CREATE TABLE IF NOT EXISTS user_watchlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  market_id text NOT NULL, -- References unified_markets.id format: venue:venue_market_id
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, market_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_watchlist_user_id ON user_watchlist(user_id);
CREATE INDEX IF NOT EXISTS idx_user_watchlist_market_id ON user_watchlist(market_id);
CREATE INDEX IF NOT EXISTS idx_user_watchlist_created_at ON user_watchlist(created_at DESC);

-- Add foreign key constraint to ensure market exists (optional, but helps with data integrity)
-- Note: We can't add a direct foreign key to unified_markets.id since it's a text composite key
-- The application layer will validate market existence before insertion

