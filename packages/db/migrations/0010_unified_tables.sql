-- Unified tables migration
-- This migration creates unified events and markets tables that normalize data from Polymarket, Kalshi, and Limitless

-- Create enum for standardized status values
CREATE TYPE unified_status AS ENUM ('ACTIVE', 'CLOSED', 'SETTLED', 'ARCHIVED');

-- Unified events table - stores normalized event data from all venues
CREATE TABLE IF NOT EXISTS unified_events (
  id text PRIMARY KEY, -- Composite ID: venue:venue_event_id
  venue text NOT NULL, -- 'polymarket', 'kalshi', 'limitless'
  venue_event_id text NOT NULL, -- Original venue event ID
  title text NOT NULL,
  description text,
  category text,
  status unified_status NOT NULL,
  start_date timestamptz,
  end_date timestamptz,
  volume_total numeric,
  volume_24h numeric,
  liquidity numeric,
  created_at timestamptz,
  updated_at timestamptz,
  created_at_db timestamptz DEFAULT now(),
  updated_at_db timestamptz DEFAULT now(),
  
  -- Composite unique constraint
  CONSTRAINT unique_venue_event UNIQUE (venue, venue_event_id)
);

-- Unified markets table - stores normalized market data from all venues
CREATE TABLE IF NOT EXISTS unified_markets (
  id text PRIMARY KEY, -- Composite ID: venue:venue_market_id
  venue text NOT NULL, -- 'polymarket', 'kalshi', 'limitless'
  venue_market_id text NOT NULL, -- Original venue market ID
  event_id text NOT NULL REFERENCES unified_events(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  category text,
  status unified_status NOT NULL,
  market_type text NOT NULL,
  open_time timestamptz,
  close_time timestamptz,
  expiration_time timestamptz,
  best_bid numeric,
  best_ask numeric,
  last_price numeric,
  volume_total numeric,
  volume_24h numeric,
  liquidity numeric,
  outcomes text, -- JSON string of outcomes array
  created_at timestamptz,
  updated_at timestamptz,
  created_at_db timestamptz DEFAULT now(),
  updated_at_db timestamptz DEFAULT now(),
  
  -- Composite unique constraint
  CONSTRAINT unique_venue_market UNIQUE (venue, venue_market_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_unified_events_venue ON unified_events(venue);
CREATE INDEX IF NOT EXISTS idx_unified_events_status ON unified_events(status);
CREATE INDEX IF NOT EXISTS idx_unified_events_venue_event_id ON unified_events(venue_event_id);
CREATE INDEX IF NOT EXISTS idx_unified_events_end_date ON unified_events(end_date DESC);
CREATE INDEX IF NOT EXISTS idx_unified_events_volume_total ON unified_events(volume_total DESC);
CREATE INDEX IF NOT EXISTS idx_unified_events_liquidity ON unified_events(liquidity DESC);

CREATE INDEX IF NOT EXISTS idx_unified_markets_venue ON unified_markets(venue);
CREATE INDEX IF NOT EXISTS idx_unified_markets_status ON unified_markets(status);
CREATE INDEX IF NOT EXISTS idx_unified_markets_venue_market_id ON unified_markets(venue_market_id);
CREATE INDEX IF NOT EXISTS idx_unified_markets_event_id ON unified_markets(event_id);
CREATE INDEX IF NOT EXISTS idx_unified_markets_expiration_time ON unified_markets(expiration_time DESC);
CREATE INDEX IF NOT EXISTS idx_unified_markets_volume_total ON unified_markets(volume_total DESC);
CREATE INDEX IF NOT EXISTS idx_unified_markets_liquidity ON unified_markets(liquidity DESC);
CREATE INDEX IF NOT EXISTS idx_unified_markets_best_bid ON unified_markets(best_bid DESC);
CREATE INDEX IF NOT EXISTS idx_unified_markets_best_ask ON unified_markets(best_ask DESC);

-- Triggers for updated_at_db timestamps
CREATE OR REPLACE FUNCTION update_unified_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at_db = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_unified_events_updated_at_db 
    BEFORE UPDATE ON unified_events 
    FOR EACH ROW EXECUTE FUNCTION update_unified_updated_at_column();

CREATE TRIGGER update_unified_markets_updated_at_db 
    BEFORE UPDATE ON unified_markets 
    FOR EACH ROW EXECUTE FUNCTION update_unified_updated_at_column();
