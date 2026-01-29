CREATE TABLE IF NOT EXISTS unified_market_tokens (
  market_id text NOT NULL REFERENCES unified_markets(id) ON DELETE CASCADE,
  token_id text NOT NULL,
  venue text NOT NULL,
  outcome_side text NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (market_id, token_id)
);

CREATE INDEX IF NOT EXISTS idx_unified_market_tokens_token_id
  ON unified_market_tokens(token_id);

CREATE INDEX IF NOT EXISTS idx_unified_market_tokens_market_id
  ON unified_market_tokens(market_id);

CREATE INDEX IF NOT EXISTS idx_unified_market_tokens_venue_token
  ON unified_market_tokens(venue, token_id);
