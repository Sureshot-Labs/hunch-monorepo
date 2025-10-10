-- Kalshi-specific table migration
-- This migration creates a dedicated table for Kalshi data structure

-- Kalshi events table - stores the main event data
CREATE TABLE IF NOT EXISTS kalshi_events (
  id text PRIMARY KEY, -- Kalshi's native event ticker
  event_ticker text NOT NULL UNIQUE,
  series_ticker text,
  sub_title text,
  title text NOT NULL,
  collateral_return_type text,
  mutually_exclusive boolean DEFAULT false,
  category text,
  price_level_structure text,
  available_on_brokers boolean DEFAULT false,
  raw jsonb NOT NULL,
  created_at_db timestamptz DEFAULT now(),
  updated_at_db timestamptz DEFAULT now()
);

-- Kalshi markets table - stores individual markets within events
CREATE TABLE IF NOT EXISTS kalshi_markets (
  id text PRIMARY KEY, -- Kalshi's native market ticker
  event_ticker text NOT NULL REFERENCES kalshi_events(event_ticker) ON DELETE CASCADE,
  market_type text NOT NULL,
  title text,
  subtitle text,
  yes_sub_title text,
  no_sub_title text,
  open_time timestamptz,
  close_time timestamptz,
  expected_expiration_time timestamptz,
  expiration_time timestamptz,
  latest_expiration_time timestamptz,
  settlement_timer_seconds integer,
  status text NOT NULL,
  response_price_units text,
  notional_value numeric,
  notional_value_dollars numeric,
  yes_bid numeric,
  yes_bid_dollars numeric,
  yes_ask numeric,
  yes_ask_dollars numeric,
  no_bid numeric,
  no_bid_dollars numeric,
  no_ask numeric,
  no_ask_dollars numeric,
  last_price numeric,
  last_price_dollars numeric,
  previous_yes_bid numeric,
  previous_yes_bid_dollars numeric,
  previous_yes_ask numeric,
  previous_yes_ask_dollars numeric,
  previous_price numeric,
  previous_price_dollars numeric,
  volume numeric,
  volume_24h numeric,
  liquidity numeric,
  liquidity_dollars numeric,
  open_interest numeric,
  result text,
  can_close_early boolean,
  expiration_value text,
  category text,
  risk_limit_cents numeric,
  rules_primary text,
  rules_secondary text,
  early_close_condition text,
  tick_size numeric,
  raw jsonb NOT NULL,
  created_at_db timestamptz DEFAULT now(),
  updated_at_db timestamptz DEFAULT now()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_kalshi_events_event_ticker ON kalshi_events(event_ticker);
CREATE INDEX IF NOT EXISTS idx_kalshi_events_series_ticker ON kalshi_events(series_ticker);
CREATE INDEX IF NOT EXISTS idx_kalshi_events_category ON kalshi_events(category);
CREATE INDEX IF NOT EXISTS idx_kalshi_events_mutually_exclusive ON kalshi_events(mutually_exclusive);

CREATE INDEX IF NOT EXISTS idx_kalshi_markets_event_ticker ON kalshi_markets(event_ticker);
CREATE INDEX IF NOT EXISTS idx_kalshi_markets_status ON kalshi_markets(status);
CREATE INDEX IF NOT EXISTS idx_kalshi_markets_liquidity ON kalshi_markets(liquidity DESC);
CREATE INDEX IF NOT EXISTS idx_kalshi_markets_volume ON kalshi_markets(volume DESC);
CREATE INDEX IF NOT EXISTS idx_kalshi_markets_volume_24h ON kalshi_markets(volume_24h DESC);
CREATE INDEX IF NOT EXISTS idx_kalshi_markets_open_time ON kalshi_markets(open_time);
CREATE INDEX IF NOT EXISTS idx_kalshi_markets_close_time ON kalshi_markets(close_time);
CREATE INDEX IF NOT EXISTS idx_kalshi_markets_expiration_time ON kalshi_markets(expiration_time);

-- Triggers for updated_at_db timestamps
CREATE OR REPLACE FUNCTION update_kalshi_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at_db = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_kalshi_events_updated_at_db 
    BEFORE UPDATE ON kalshi_events 
    FOR EACH ROW EXECUTE FUNCTION update_kalshi_updated_at_column();

CREATE TRIGGER update_kalshi_markets_updated_at_db 
    BEFORE UPDATE ON kalshi_markets 
    FOR EACH ROW EXECUTE FUNCTION update_kalshi_updated_at_column();
