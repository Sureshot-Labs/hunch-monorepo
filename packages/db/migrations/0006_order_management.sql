-- Phase 3: Order Management Migration
-- This migration adds order management, position tracking, and venue abstraction

-- Orders table - stores both internal and venue order IDs
-- Add new columns to existing orders table
DO $$
BEGIN
    -- Add venue column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'venue') THEN
        ALTER TABLE orders ADD COLUMN venue text CHECK (venue IN ('polymarket', 'kalshi', 'limitless'));
    END IF;
    
    -- Add venue_order_id column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'venue_order_id') THEN
        ALTER TABLE orders ADD COLUMN venue_order_id text;
    END IF;
    
    -- Add order_type column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'order_type') THEN
        ALTER TABLE orders ADD COLUMN order_type text CHECK (order_type IN ('GTC', 'GTD', 'FAK', 'FOK'));
    END IF;
    
    -- Add filled_size column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'filled_size') THEN
        ALTER TABLE orders ADD COLUMN filled_size numeric DEFAULT 0;
    END IF;
    
    -- Add average_fill_price column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'average_fill_price') THEN
        ALTER TABLE orders ADD COLUMN average_fill_price numeric;
    END IF;
    
    -- Add expires_at column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'expires_at') THEN
        ALTER TABLE orders ADD COLUMN expires_at timestamptz;
    END IF;
    
    -- Add filled_at column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'filled_at') THEN
        ALTER TABLE orders ADD COLUMN filled_at timestamptz;
    END IF;
    
    -- Add cancelled_at column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'cancelled_at') THEN
        ALTER TABLE orders ADD COLUMN cancelled_at timestamptz;
    END IF;
    
    -- Add error_message column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'error_message') THEN
        ALTER TABLE orders ADD COLUMN error_message text;
    END IF;
    
    -- Add raw_error column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'raw_error') THEN
        ALTER TABLE orders ADD COLUMN raw_error text;
    END IF;
END $$;

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
CREATE INDEX IF NOT EXISTS idx_orders_posted_at ON orders(posted_at);
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
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name = 'update_orders_last_update') THEN
        CREATE TRIGGER update_orders_last_update BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name = 'update_positions_updated_at') THEN
        CREATE TRIGGER update_positions_updated_at BEFORE UPDATE ON positions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;
