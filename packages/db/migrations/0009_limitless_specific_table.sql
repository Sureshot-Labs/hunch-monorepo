-- Limitless-specific table migration
-- This migration creates a dedicated table for Limitless data structure

-- Limitless events table - stores the main event data
CREATE TABLE IF NOT EXISTS limitless_events (
  id text PRIMARY KEY, -- Limitless's native event ID
  slug text,
  title text NOT NULL,
  description text,
  tags text[], -- Array of tags
  status text NOT NULL DEFAULT 'FUNDED',
  expired boolean DEFAULT false,
  creator_name text,
  creator_image_uri text,
  creator_link text,
  logo text,
  categories text[], -- Array of categories
  market_type text NOT NULL, -- 'single' or 'group'
  proxy_title text,
  condition_id text,
  is_rewardable boolean DEFAULT false,
  priority_index integer DEFAULT 0,
  expiration_date text,
  expiration_timestamp bigint,
  volume text, -- Often integer in micro units
  volume_formatted text, -- Human readable format like "1498.445769"
  volume_total numeric, -- Parsed numeric value
  trends_rank integer,
  trends_value integer,
  metadata_fee boolean DEFAULT false,
  metadata_is_bannered boolean DEFAULT false,
  metadata_is_poly_arbitrage boolean DEFAULT false,
  metadata_should_market_make boolean DEFAULT false,
  settings_c text,
  settings_min_size text,
  settings_max_spread numeric,
  settings_daily_reward text,
  settings_rewards_epoch text,
  collateral_token_symbol text,
  collateral_token_address text,
  collateral_token_decimals integer DEFAULT 6,
  neg_risk_request_id text,
  neg_risk_market_id text,
  winning_outcome_index integer,
  og_image_uri text,
  daily_reward text,
  outcome_tokens text[], -- Array of outcome tokens
  trade_type text DEFAULT 'clob',
  created_at timestamptz,
  updated_at timestamptz,
  raw jsonb NOT NULL,
  created_at_db timestamptz DEFAULT now(),
  updated_at_db timestamptz DEFAULT now()
);

-- Limitless markets table - stores individual markets within events
CREATE TABLE IF NOT EXISTS limitless_markets (
  id text PRIMARY KEY, -- Limitless's native market ID
  event_id text NOT NULL REFERENCES limitless_events(id) ON DELETE CASCADE,
  slug text,
  title text NOT NULL,
  description text,
  tags text[], -- Array of tags
  status text NOT NULL DEFAULT 'FUNDED',
  expired boolean DEFAULT false,
  creator_name text,
  creator_image_uri text,
  creator_link text,
  logo text,
  categories text[], -- Array of categories
  market_type text NOT NULL, -- 'single' or 'group'
  proxy_title text,
  condition_id text,
  is_rewardable boolean DEFAULT false,
  priority_index integer DEFAULT 0,
  expiration_date text,
  expiration_timestamp bigint,
  volume text, -- Often integer in micro units
  volume_formatted text, -- Human readable format
  volume_total numeric, -- Parsed numeric value
  prices numeric[], -- Array of prices [yes%, no%]
  tokens_no text, -- Token ID for NO outcome
  tokens_yes text, -- Token ID for YES outcome
  metadata_fee boolean DEFAULT false,
  metadata_is_bannered boolean DEFAULT false,
  metadata_is_poly_arbitrage boolean DEFAULT false,
  metadata_should_market_make boolean DEFAULT false,
  settings_c text,
  settings_min_size text,
  settings_max_spread numeric,
  settings_daily_reward text,
  settings_rewards_epoch text,
  collateral_token_symbol text,
  collateral_token_address text,
  collateral_token_decimals integer DEFAULT 6,
  neg_risk_request_id text,
  winning_outcome_index integer,
  trade_type text DEFAULT 'clob',
  created_at timestamptz,
  updated_at timestamptz,
  raw jsonb NOT NULL,
  created_at_db timestamptz DEFAULT now(),
  updated_at_db timestamptz DEFAULT now()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_limitless_events_status ON limitless_events(status);
CREATE INDEX IF NOT EXISTS idx_limitless_events_expired ON limitless_events(expired);
CREATE INDEX IF NOT EXISTS idx_limitless_events_market_type ON limitless_events(market_type);
CREATE INDEX IF NOT EXISTS idx_limitless_events_expiration_timestamp ON limitless_events(expiration_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_limitless_events_volume_total ON limitless_events(volume_total DESC);
CREATE INDEX IF NOT EXISTS idx_limitless_events_created_at ON limitless_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_limitless_events_updated_at ON limitless_events(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_limitless_markets_event_id ON limitless_markets(event_id);
CREATE INDEX IF NOT EXISTS idx_limitless_markets_status ON limitless_markets(status);
CREATE INDEX IF NOT EXISTS idx_limitless_markets_expired ON limitless_markets(expired);
CREATE INDEX IF NOT EXISTS idx_limitless_markets_market_type ON limitless_markets(market_type);
CREATE INDEX IF NOT EXISTS idx_limitless_markets_expiration_timestamp ON limitless_markets(expiration_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_limitless_markets_volume_total ON limitless_markets(volume_total DESC);
CREATE INDEX IF NOT EXISTS idx_limitless_markets_created_at ON limitless_markets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_limitless_markets_updated_at ON limitless_markets(updated_at DESC);

-- Triggers for updated_at_db timestamps
CREATE OR REPLACE FUNCTION update_limitless_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at_db = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_limitless_events_updated_at_db 
    BEFORE UPDATE ON limitless_events 
    FOR EACH ROW EXECUTE FUNCTION update_limitless_updated_at_column();

CREATE TRIGGER update_limitless_markets_updated_at_db 
    BEFORE UPDATE ON limitless_markets 
    FOR EACH ROW EXECUTE FUNCTION update_limitless_updated_at_column();
