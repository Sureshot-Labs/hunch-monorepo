-- Phase 3: Order Management Migration
-- This migration adds order management, position tracking, and venue abstraction

-- Orders table - stores both internal and venue order IDs
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Internal order ID
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  venue text NOT NULL CHECK (venue IN ('polymarket', 'kalshi', 'limitless')),
  venue_order_id text, -- Venue's order ID (set after successful placement)
  
  -- Order details
  token_id text NOT NULL,
  side text NOT NULL CHECK (side IN ('BUY', 'SELL')),
  order_type text NOT NULL CHECK (order_type IN ('GTC', 'GTD', 'FAK', 'FOK')),
  price numeric NOT NULL,
  size numeric NOT NULL,
  
  -- Order state
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'submitted', 'live', 'matched', 'partially_filled', 
    'filled', 'cancelled', 'rejected', 'expired', 'delayed', 'unmatched'
  )),
  
  -- Execution details
  filled_size numeric DEFAULT 0,
  average_fill_price numeric,
  
  -- Timing
  expires_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  filled_at timestamptz,
  cancelled_at timestamptz,
  
  -- Metadata
  error_message text, -- User-friendly error message
  raw_error text, -- Original venue error for logging
  
  -- Indexes
  UNIQUE(id), -- Internal ID is unique
  UNIQUE(venue, venue_order_id) -- Venue order ID is unique within venue
);

-- Order fills table - tracks partial fills
CREATE TABLE IF NOT EXISTS order_fills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  venue_fill_id text, -- Venue's fill/trade ID
  
  -- Fill details
  fill_size numeric NOT NULL,
  fill_price numeric NOT NULL,
  fill_side text NOT NULL CHECK (fill_side IN ('BUY', 'SELL')),
  
  -- Timing
  filled_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now(),
  
  -- Metadata
  venue_trade_id text, -- Reference to venue's trade record
  fees numeric DEFAULT 0
);

-- Positions table - cached position data from venues
CREATE TABLE IF NOT EXISTS positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  venue text NOT NULL CHECK (venue IN ('polymarket', 'kalshi', 'limitless')),
  token_id text NOT NULL,
  
  -- Position details
  side text NOT NULL CHECK (side IN ('LONG', 'SHORT', 'FLAT')),
  size numeric NOT NULL DEFAULT 0,
  average_price numeric,
  unrealized_pnl numeric DEFAULT 0,
  realized_pnl numeric DEFAULT 0,
  
  -- Metadata
  last_updated_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  
  -- Unique constraint
  UNIQUE(user_id, venue, token_id)
);

-- Order logs table - detailed error logging
CREATE TABLE IF NOT EXISTS order_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES orders(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  venue text NOT NULL,
  
  -- Log details
  log_level text NOT NULL CHECK (log_level IN ('INFO', 'WARN', 'ERROR', 'DEBUG')),
  message text NOT NULL,
  raw_data jsonb, -- Original venue response/error
  
  -- Context
  action text NOT NULL, -- 'place_order', 'cancel_order', 'get_order', etc.
  venue_order_id text,
  
  -- Timing
  created_at timestamptz DEFAULT now()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_venue ON orders(venue);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_venue_order_id ON orders(venue, venue_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_token_id ON orders(token_id);

CREATE INDEX IF NOT EXISTS idx_order_fills_order_id ON order_fills(order_id);
CREATE INDEX IF NOT EXISTS idx_order_fills_filled_at ON order_fills(filled_at);
CREATE INDEX IF NOT EXISTS idx_order_fills_venue_fill_id ON order_fills(venue_fill_id);

CREATE INDEX IF NOT EXISTS idx_positions_user_id ON positions(user_id);
CREATE INDEX IF NOT EXISTS idx_positions_venue ON positions(venue);
CREATE INDEX IF NOT EXISTS idx_positions_token_id ON positions(token_id);
CREATE INDEX IF NOT EXISTS idx_positions_last_updated ON positions(last_updated_at);

CREATE INDEX IF NOT EXISTS idx_order_logs_order_id ON order_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_order_logs_user_id ON order_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_order_logs_venue ON order_logs(venue);
CREATE INDEX IF NOT EXISTS idx_order_logs_created_at ON order_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_order_logs_log_level ON order_logs(log_level);

-- Triggers for updated_at timestamps
CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_positions_updated_at BEFORE UPDATE ON positions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
