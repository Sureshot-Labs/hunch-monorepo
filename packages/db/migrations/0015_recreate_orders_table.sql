-- Recreate orders table after it was dropped in 0011_drop_legacy_tables.sql
-- This migration recreates the orders table with all the necessary columns for order management

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  venue text CHECK (venue IN ('polymarket', 'kalshi', 'limitless')),
  venue_order_id text,
  token_id text,
  side text CHECK (side IN ('BUY','SELL')),
  order_type text CHECK (order_type IN ('GTC', 'GTD', 'FAK', 'FOK')),
  price numeric CHECK (price >= 0 AND price <= 1),
  size numeric CHECK (size > 0),
  status text NOT NULL,
  filled_size numeric DEFAULT 0,
  average_fill_price numeric,
  expires_at timestamptz,
  filled_at timestamptz,
  cancelled_at timestamptz,
  error_message text,
  raw_error text,
  posted_at timestamptz DEFAULT now(),
  last_update timestamptz DEFAULT now()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_venue ON orders(venue);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_posted_at ON orders(posted_at);
CREATE INDEX IF NOT EXISTS idx_orders_venue_order_id ON orders(venue, venue_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_token_id ON orders(token_id);

-- Create trigger for updated_at timestamp
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name = 'update_orders_last_update') THEN
        CREATE TRIGGER update_orders_last_update 
        BEFORE UPDATE ON orders 
        FOR EACH ROW 
        EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;
