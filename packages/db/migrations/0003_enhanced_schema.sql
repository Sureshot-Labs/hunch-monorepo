-- Enhanced schema for trading and price history
-- Migration: 0003_enhanced_schema.sql

-- =========================
-- USER MANAGEMENT
-- =========================

-- Users table for authentication and trading
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    is_active BOOLEAN DEFAULT true,
    is_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    last_login TIMESTAMPTZ
);

-- User wallets for tracking balances
CREATE TABLE IF NOT EXISTS user_wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    venue TEXT NOT NULL, -- 'polymarket', 'kalshi', etc.
    wallet_address TEXT,
    balance_usd NUMERIC DEFAULT 0,
    balance_tokens NUMERIC DEFAULT 0,
    token_symbol TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, venue)
);

-- =========================
-- ENHANCED MARKET DATA
-- =========================

-- Enhanced markets table with unified fields
ALTER TABLE markets ADD COLUMN IF NOT EXISTS unified_token_id_yes TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS unified_token_id_no TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS normalized_yes_price NUMERIC CHECK (normalized_yes_price >= 0 AND normalized_yes_price <= 1);
ALTER TABLE markets ADD COLUMN IF NOT EXISTS normalized_no_price NUMERIC CHECK (normalized_no_price >= 0 AND normalized_no_price <= 1);
ALTER TABLE markets ADD COLUMN IF NOT EXISTS min_order_size_usd NUMERIC DEFAULT 1;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS max_order_size_usd NUMERIC;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS tick_size NUMERIC DEFAULT 0.01;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'closed', 'settled'));
ALTER TABLE markets ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

-- Create indexes for new fields
CREATE INDEX IF NOT EXISTS idx_markets_unified_tokens ON markets(unified_token_id_yes, unified_token_id_no);
CREATE INDEX IF NOT EXISTS idx_markets_status ON markets(status);
CREATE INDEX IF NOT EXISTS idx_markets_normalized_prices ON markets(normalized_yes_price, normalized_no_price);

-- =========================
-- PRICE HISTORY SYSTEM
-- =========================

-- Enhanced price history table with OHLC data
CREATE TABLE IF NOT EXISTS price_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_id TEXT NOT NULL REFERENCES tokens(token_id),
    timestamp TIMESTAMPTZ NOT NULL,
    
    -- OHLC Data (normalized to 0-1 range)
    open_price NUMERIC NOT NULL CHECK (open_price >= 0 AND open_price <= 1),
    high_price NUMERIC NOT NULL CHECK (high_price >= 0 AND high_price <= 1),
    low_price NUMERIC NOT NULL CHECK (low_price >= 0 AND low_price <= 1),
    close_price NUMERIC NOT NULL CHECK (close_price >= 0 AND close_price <= 1),
    
    -- Volume Data
    volume_usd NUMERIC NOT NULL DEFAULT 0,
    trade_count INTEGER NOT NULL DEFAULT 0,
    
    -- Market Data
    best_bid NUMERIC CHECK (best_bid >= 0 AND best_bid <= 1),
    best_ask NUMERIC CHECK (best_ask >= 0 AND best_ask <= 1),
    spread NUMERIC CHECK (spread >= 0),
    
    -- Aggregation Level
    resolution INTERVAL NOT NULL, -- '1m', '5m', '1h', '1d', etc.
    
    created_at TIMESTAMPTZ DEFAULT now(),
    
    UNIQUE(token_id, timestamp, resolution)
);

-- Create hypertable for time-series optimization
SELECT create_hypertable('price_history', 'timestamp', 
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

-- Indexes for price history
CREATE INDEX IF NOT EXISTS idx_price_history_token_time ON price_history(token_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_price_history_resolution ON price_history(resolution, timestamp DESC);

-- =========================
-- TRADING SYSTEM
-- =========================

-- Orders table for trading
CREATE TABLE IF NOT EXISTS trading_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    venue TEXT NOT NULL,
    token_id TEXT NOT NULL REFERENCES tokens(token_id),
    
    -- Order Details
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    order_type TEXT NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT', 'STOP')),
    price NUMERIC CHECK (price >= 0 AND price <= 1),
    size_usd NUMERIC NOT NULL CHECK (size_usd > 0),
    size_tokens NUMERIC,
    
    -- Status Tracking
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'FILLED', 'PARTIALLY_FILLED', 'CANCELLED', 'REJECTED')),
    filled_size_usd NUMERIC DEFAULT 0,
    filled_size_tokens NUMERIC DEFAULT 0,
    average_fill_price NUMERIC,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    filled_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    
    -- External References
    venue_order_id TEXT, -- Order ID from the venue
    venue_tx_hash TEXT,  -- Transaction hash from venue
    
    -- Metadata
    raw_data JSONB,
    
    UNIQUE(user_id, venue_order_id)
);

-- Indexes for orders
CREATE INDEX IF NOT EXISTS idx_orders_user ON trading_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_token ON trading_orders(token_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON trading_orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_venue ON trading_orders(venue, created_at DESC);

-- Trades table for executed trades
CREATE TABLE IF NOT EXISTS trading_trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES trading_orders(id),
    user_id UUID NOT NULL REFERENCES users(id),
    venue TEXT NOT NULL,
    token_id TEXT NOT NULL REFERENCES tokens(token_id),
    
    -- Trade Details
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    price NUMERIC NOT NULL CHECK (price >= 0 AND price <= 1),
    size_usd NUMERIC NOT NULL CHECK (size_usd > 0),
    size_tokens NUMERIC,
    
    -- Timestamps
    executed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    
    -- External References
    venue_trade_id TEXT,
    venue_tx_hash TEXT,
    
    -- Fees
    fee_usd NUMERIC DEFAULT 0,
    fee_tokens NUMERIC DEFAULT 0,
    
    -- Metadata
    raw_data JSONB
);

-- Indexes for trades
CREATE INDEX IF NOT EXISTS idx_trades_user ON trading_trades(user_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_token ON trading_trades(token_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_venue ON trading_trades(venue, executed_at DESC);

-- User positions table
CREATE TABLE IF NOT EXISTS user_positions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    token_id TEXT NOT NULL REFERENCES tokens(token_id),
    
    -- Position Details
    side TEXT NOT NULL CHECK (side IN ('YES', 'NO')),
    quantity NUMERIC NOT NULL DEFAULT 0,
    average_price NUMERIC,
    unrealized_pnl_usd NUMERIC DEFAULT 0,
    realized_pnl_usd NUMERIC DEFAULT 0,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    
    UNIQUE(user_id, token_id, side)
);

-- Indexes for positions
CREATE INDEX IF NOT EXISTS idx_positions_user ON user_positions(user_id);
CREATE INDEX IF NOT EXISTS idx_positions_token ON user_positions(token_id);

-- =========================
-- PRICE AGGREGATIONS
-- =========================

-- Materialized view for 1-minute aggregations
CREATE MATERIALIZED VIEW IF NOT EXISTS price_aggregations_1m AS
SELECT 
    token_id,
    time_bucket('1 minute', timestamp) AS bucket,
    first(open_price, timestamp) AS open,
    max(high_price) AS high,
    min(low_price) AS low,
    last(close_price, timestamp) AS close,
    sum(volume_usd) AS volume,
    sum(trade_count) AS trades,
    avg(best_bid) AS avg_bid,
    avg(best_ask) AS avg_ask,
    avg(spread) AS avg_spread
FROM price_history 
WHERE resolution = '1 minute'
GROUP BY token_id, bucket
WITH NO DATA;

-- Materialized view for 5-minute aggregations
CREATE MATERIALIZED VIEW IF NOT EXISTS price_aggregations_5m AS
SELECT 
    token_id,
    time_bucket('5 minutes', timestamp) AS bucket,
    first(open_price, timestamp) AS open,
    max(high_price) AS high,
    min(low_price) AS low,
    last(close_price, timestamp) AS close,
    sum(volume_usd) AS volume,
    sum(trade_count) AS trades,
    avg(best_bid) AS avg_bid,
    avg(best_ask) AS avg_ask,
    avg(spread) AS avg_spread
FROM price_history 
WHERE resolution = '1 minute'
GROUP BY token_id, bucket
WITH NO DATA;

-- Materialized view for 1-hour aggregations
CREATE MATERIALIZED VIEW IF NOT EXISTS price_aggregations_1h AS
SELECT 
    token_id,
    time_bucket('1 hour', timestamp) AS bucket,
    first(open_price, timestamp) AS open,
    max(high_price) AS high,
    min(low_price) AS low,
    last(close_price, timestamp) AS close,
    sum(volume_usd) AS volume,
    sum(trade_count) AS trades,
    avg(best_bid) AS avg_bid,
    avg(best_ask) AS avg_ask,
    avg(spread) AS avg_spread
FROM price_history 
WHERE resolution = '1 minute'
GROUP BY token_id, bucket
WITH NO DATA;

-- Materialized view for 1-day aggregations
CREATE MATERIALIZED VIEW IF NOT EXISTS price_aggregations_1d AS
SELECT 
    token_id,
    time_bucket('1 day', timestamp) AS bucket,
    first(open_price, timestamp) AS open,
    max(high_price) AS high,
    min(low_price) AS low,
    last(close_price, timestamp) AS close,
    sum(volume_usd) AS volume,
    sum(trade_count) AS trades,
    avg(best_bid) AS avg_bid,
    avg(best_ask) AS avg_ask,
    avg(spread) AS avg_spread
FROM price_history 
WHERE resolution = '1 minute'
GROUP BY token_id, bucket
WITH NO DATA;

-- =========================
-- CONTINUOUS AGGREGATION POLICIES
-- =========================

-- Add continuous aggregation policies
SELECT add_continuous_aggregate_policy(
    'price_aggregations_1m',
    start_offset => INTERVAL '7 days',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute'
);

SELECT add_continuous_aggregate_policy(
    'price_aggregations_5m',
    start_offset => INTERVAL '30 days',
    end_offset => INTERVAL '5 minutes',
    schedule_interval => INTERVAL '5 minutes'
);

SELECT add_continuous_aggregate_policy(
    'price_aggregations_1h',
    start_offset => INTERVAL '90 days',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour'
);

SELECT add_continuous_aggregate_policy(
    'price_aggregations_1d',
    start_offset => INTERVAL '365 days',
    end_offset => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 day'
);

-- =========================
-- RETENTION POLICIES
-- =========================

-- Add retention policies for price history
SELECT add_retention_policy('price_history', INTERVAL '90 days');
SELECT add_retention_policy('price_aggregations_1m', INTERVAL '30 days');
SELECT add_aggregation_policy('price_aggregations_5m', INTERVAL '90 days');
SELECT add_aggregation_policy('price_aggregations_1h', INTERVAL '365 days');
SELECT add_aggregation_policy('price_aggregations_1d', INTERVAL '1095 days'); -- 3 years

-- =========================
-- COMPRESSION POLICIES
-- =========================

-- Enable compression for price history
ALTER TABLE price_history SET (timescaledb.compress, 
    timescaledb.compress_orderby = 'timestamp DESC', 
    timescaledb.compress_segmentby = 'token_id'
);

-- Add compression policy
SELECT add_compression_policy('price_history', INTERVAL '7 days');

-- =========================
-- FUNCTIONS AND TRIGGERS
-- =========================

-- Function to update user positions
CREATE OR REPLACE FUNCTION update_user_position()
RETURNS TRIGGER AS $$
BEGIN
    -- Update position when trade is executed
    INSERT INTO user_positions (user_id, token_id, side, quantity, average_price)
    VALUES (
        NEW.user_id,
        NEW.token_id,
        CASE WHEN NEW.side = 'BUY' THEN 'YES' ELSE 'NO' END,
        NEW.size_tokens,
        NEW.price
    )
    ON CONFLICT (user_id, token_id, side) 
    DO UPDATE SET
        quantity = user_positions.quantity + NEW.size_tokens,
        average_price = (user_positions.quantity * user_positions.average_price + NEW.size_tokens * NEW.price) / (user_positions.quantity + NEW.size_tokens),
        updated_at = now();
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update positions on trade execution
CREATE TRIGGER update_position_on_trade
    AFTER INSERT ON trading_trades
    FOR EACH ROW
    EXECUTE FUNCTION update_user_position();

-- Function to update market prices
CREATE OR REPLACE FUNCTION update_market_prices()
RETURNS TRIGGER AS $$
BEGIN
    -- Update normalized prices in markets table
    UPDATE markets 
    SET 
        normalized_yes_price = CASE 
            WHEN clob_token_yes = NEW.token_id THEN NEW.close_price
            ELSE normalized_yes_price 
        END,
        normalized_no_price = CASE 
            WHEN clob_token_no = NEW.token_id THEN NEW.close_price
            ELSE normalized_no_price 
        END,
        updated_at = now()
    WHERE clob_token_yes = NEW.token_id OR clob_token_no = NEW.token_id;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update market prices
CREATE TRIGGER update_market_prices_trigger
    AFTER INSERT ON price_history
    FOR EACH ROW
    EXECUTE FUNCTION update_market_prices();
