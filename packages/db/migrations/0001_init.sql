-- Enable TimescaleDB
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Venues (future-proofing)
CREATE TABLE IF NOT EXISTS venues(
  id serial PRIMARY KEY,
  name text UNIQUE NOT NULL,
  api_base text,
  ws_url text,
  created_at timestamptz DEFAULT now()
);

INSERT INTO venues(name) VALUES ('polymarket') ON CONFLICT DO NOTHING;
INSERT INTO venues(name) VALUES ('kalshi') ON CONFLICT DO NOTHING;
INSERT INTO venues(name) VALUES ('limitless') ON CONFLICT DO NOTHING;


-- Events from Gamma API (event_id is venue's native id)
CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY,                               -- our uuid
  venue_id int NOT NULL REFERENCES venues(id),
  event_id text NOT NULL,                            -- e.g. "24087"
  title text NOT NULL,
  category text,
  slug text,
  active boolean DEFAULT true,
  closed boolean DEFAULT false,
  start_time timestamptz,                            -- fixed name
  end_time timestamptz,
  liquidity numeric,
  volume_total numeric,                              -- "volume"
  volume24hr numeric,
  raw jsonb NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(venue_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_events_active_closed ON events(active, closed);
CREATE INDEX IF NOT EXISTS idx_events_end_time ON events(end_time DESC);

-- Markets inside an event
CREATE TABLE IF NOT EXISTS markets (
  id uuid PRIMARY KEY,                               -- our uuid
  event_id uuid NOT NULL REFERENCES events(id),
  venue_id int NOT NULL REFERENCES venues(id),
  market_id text NOT NULL,                           -- e.g. "542537"
  title text NOT NULL,
  enable_orderbook boolean DEFAULT true,
  accepting_orders boolean DEFAULT true,
  condition_id text,                                 -- for CLOB and resolution ties
  order_price_min_tick_size numeric,                 -- from orderPriceMinTickSize
  order_min_size numeric,                            -- from orderMinSize
  neg_risk boolean,
  neg_risk_market_id text,
  liquidity numeric,
  volume_total numeric,                              -- "volume"
  volume24hr numeric,
  clob_token_yes text,
  clob_token_no text,
  raw jsonb NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (venue_id, market_id)
);

CREATE INDEX IF NOT EXISTS idx_markets_event ON markets(event_id);
CREATE INDEX IF NOT EXISTS idx_markets_liquidity ON markets(liquidity DESC);
CREATE INDEX IF NOT EXISTS idx_markets_volume ON markets(volume24hr DESC);

-- Token registry (YES/NO tokens)
-- Use token_id as the primary key since venue APIs use it everywhere
CREATE TABLE IF NOT EXISTS tokens (
  token_id text PRIMARY KEY,                         -- e.g. clobTokenIds[0]
  market_id uuid NOT NULL REFERENCES markets(id),
  side text CHECK (side IN ('YES','NO')) NOT NULL,
  UNIQUE (market_id, side)
);

-- Orders/trades mirrors (UX only)
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  venue_id int NOT NULL REFERENCES venues(id),
  token_id text NOT NULL REFERENCES tokens(token_id),
  side text CHECK (side IN ('BUY','SELL')) NOT NULL,
  price numeric NOT NULL CHECK (price >= 0 AND price <= 1),
  size numeric NOT NULL CHECK (size > 0),
  status text NOT NULL,
  posted_at timestamptz DEFAULT now(),
  last_update timestamptz DEFAULT now(),
  raw jsonb
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, posted_at DESC);

CREATE TABLE IF NOT EXISTS trades (
  id uuid PRIMARY KEY,
  order_id uuid REFERENCES orders(id),
  venue_id int NOT NULL REFERENCES venues(id),
  token_id text NOT NULL REFERENCES tokens(token_id),
  side text CHECK (side IN ('BUY','SELL')) NOT NULL,
  price numeric NOT NULL CHECK (price >= 0 AND price <= 1),
  size numeric NOT NULL CHECK (size > 0),
  match_time timestamptz NOT NULL,
  tx_hash text,
  raw jsonb
);
CREATE INDEX IF NOT EXISTS idx_trades_token_time ON trades(token_id, match_time DESC);

-- Timeseries: top-of-book and last trade
CREATE TABLE IF NOT EXISTS book_top (
  token_id text NOT NULL REFERENCES tokens(token_id),
  ts timestamptz NOT NULL,
  best_bid numeric,
  best_ask numeric,
  mid numeric,
  spread numeric,
  PRIMARY KEY (token_id, ts)
);
SELECT create_hypertable('book_top', 'ts', if_not_exists => true);

CREATE TABLE IF NOT EXISTS last_trade (
  token_id text NOT NULL REFERENCES tokens(token_id),
  ts timestamptz NOT NULL,
  price numeric NOT NULL CHECK (price >= 0 AND price <= 1),
  size numeric NOT NULL CHECK (size > 0),
  side text CHECK (side IN ('BUY','SELL')) NOT NULL,
  PRIMARY KEY (token_id, ts)
);
SELECT create_hypertable('last_trade', 'ts', if_not_exists => true);

CREATE INDEX IF NOT EXISTS idx_book_top_recent ON book_top (token_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_last_trade_recent ON last_trade (token_id, ts DESC);

-- Idempotency for POST endpoints (orders, cancels, etc)
CREATE TABLE IF NOT EXISTS idempotency (
  id bigserial PRIMARY KEY,
  user_id uuid,                       -- null if unauthenticated
  endpoint text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status smallint NOT NULL DEFAULT 0, -- 0=started,1=completed,2=failed
  response jsonb,                     -- cached response body
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, endpoint, idempotency_key)
);
