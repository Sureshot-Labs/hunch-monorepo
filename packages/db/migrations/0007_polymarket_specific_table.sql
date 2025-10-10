-- Polymarket-specific table migration
-- This migration creates a dedicated table for Polymarket data structure

-- Polymarket events table - stores the main event data
CREATE TABLE IF NOT EXISTS polymarket_events (
  id text PRIMARY KEY, -- Polymarket's native event ID
  ticker text,
  slug text,
  title text NOT NULL,
  description text,
  resolution_source text,
  start_date timestamptz,
  creation_date timestamptz,
  end_date timestamptz,
  image text,
  icon text,
  active boolean DEFAULT true,
  closed boolean DEFAULT false,
  archived boolean DEFAULT false,
  new boolean DEFAULT false,
  featured boolean DEFAULT false,
  restricted boolean DEFAULT false,
  liquidity numeric,
  volume numeric,
  open_interest numeric DEFAULT 0,
  created_by text,
  created_at timestamptz,
  updated_at timestamptz,
  competitive numeric,
  volume24hr numeric,
  volume1wk numeric,
  volume1mo numeric,
  volume1yr numeric,
  enable_order_book boolean DEFAULT true,
  liquidity_clob numeric,
  neg_risk boolean DEFAULT false,
  comment_count integer DEFAULT 0,
  raw jsonb NOT NULL,
  created_at_db timestamptz DEFAULT now(),
  updated_at_db timestamptz DEFAULT now()
);

-- Polymarket markets table - stores individual markets within events
CREATE TABLE IF NOT EXISTS polymarket_markets (
  id text PRIMARY KEY, -- Polymarket's native market ID
  event_id text NOT NULL REFERENCES polymarket_events(id) ON DELETE CASCADE,
  question text NOT NULL,
  condition_id text,
  slug text,
  resolution_source text,
  end_date timestamptz,
  liquidity numeric,
  start_date timestamptz,
  image text,
  icon text,
  description text,
  outcomes text, -- JSON string of outcomes array
  outcome_prices text, -- JSON string of prices array
  volume numeric,
  active boolean DEFAULT true,
  closed boolean DEFAULT false,
  market_maker_address text,
  created_at timestamptz,
  updated_at timestamptz,
  new boolean DEFAULT false,
  featured boolean DEFAULT false,
  submitted_by text,
  archived boolean DEFAULT false,
  resolved_by text,
  restricted boolean DEFAULT false,
  group_item_title text,
  group_item_threshold text,
  question_id text,
  enable_order_book boolean DEFAULT true,
  order_price_min_tick_size numeric,
  order_min_size numeric,
  volume_num numeric,
  liquidity_num numeric,
  end_date_iso text,
  start_date_iso text,
  has_reviewed_dates boolean DEFAULT false,
  volume24hr numeric,
  volume1wk numeric,
  volume1mo numeric,
  volume1yr numeric,
  clob_token_ids text, -- JSON string of token IDs array
  uma_bond text,
  uma_reward text,
  volume24hr_clob numeric,
  volume1wk_clob numeric,
  volume1mo_clob numeric,
  volume1yr_clob numeric,
  volume_clob numeric,
  liquidity_clob numeric,
  custom_liveness integer DEFAULT 0,
  accepting_orders boolean DEFAULT true,
  neg_risk boolean DEFAULT false,
  neg_risk_request_id text,
  ready boolean DEFAULT false,
  funded boolean DEFAULT false,
  accepting_orders_timestamp timestamptz,
  cyom boolean DEFAULT false,
  competitive numeric,
  pager_duty_notification_enabled boolean DEFAULT false,
  approved boolean DEFAULT false,
  rewards_min_size numeric,
  rewards_max_spread numeric,
  spread numeric,
  one_day_price_change numeric,
  one_hour_price_change numeric,
  one_week_price_change numeric,
  one_month_price_change numeric,
  last_trade_price numeric,
  best_bid numeric,
  best_ask numeric,
  automatically_active boolean DEFAULT true,
  clear_book_on_start boolean DEFAULT true,
  series_color text,
  show_gmp_series boolean DEFAULT false,
  show_gmp_outcome boolean DEFAULT false,
  manual_activation boolean DEFAULT false,
  neg_risk_other boolean DEFAULT false,
  uma_resolution_statuses text, -- JSON string
  pending_deployment boolean DEFAULT false,
  deploying boolean DEFAULT false,
  deploying_timestamp timestamptz,
  rfq_enabled boolean DEFAULT false,
  holding_rewards_enabled boolean DEFAULT false,
  fees_enabled boolean DEFAULT false,
  raw jsonb NOT NULL,
  created_at_db timestamptz DEFAULT now(),
  updated_at_db timestamptz DEFAULT now()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_polymarket_events_active ON polymarket_events(active);
CREATE INDEX IF NOT EXISTS idx_polymarket_events_closed ON polymarket_events(closed);
CREATE INDEX IF NOT EXISTS idx_polymarket_events_end_date ON polymarket_events(end_date DESC);
CREATE INDEX IF NOT EXISTS idx_polymarket_events_liquidity ON polymarket_events(liquidity DESC);
CREATE INDEX IF NOT EXISTS idx_polymarket_events_volume ON polymarket_events(volume DESC);

CREATE INDEX IF NOT EXISTS idx_polymarket_markets_event_id ON polymarket_markets(event_id);
CREATE INDEX IF NOT EXISTS idx_polymarket_markets_active ON polymarket_markets(active);
CREATE INDEX IF NOT EXISTS idx_polymarket_markets_closed ON polymarket_markets(closed);
CREATE INDEX IF NOT EXISTS idx_polymarket_markets_liquidity ON polymarket_markets(liquidity DESC);
CREATE INDEX IF NOT EXISTS idx_polymarket_markets_volume ON polymarket_markets(volume DESC);
CREATE INDEX IF NOT EXISTS idx_polymarket_markets_accepting_orders ON polymarket_markets(accepting_orders);

-- Triggers for updated_at_db timestamps
CREATE OR REPLACE FUNCTION update_polymarket_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at_db = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_polymarket_events_updated_at_db 
    BEFORE UPDATE ON polymarket_events 
    FOR EACH ROW EXECUTE FUNCTION update_polymarket_updated_at_column();

CREATE TRIGGER update_polymarket_markets_updated_at_db 
    BEFORE UPDATE ON polymarket_markets 
    FOR EACH ROW EXECUTE FUNCTION update_polymarket_updated_at_column();
