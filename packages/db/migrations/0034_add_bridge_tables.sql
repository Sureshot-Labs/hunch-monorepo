-- Add bridge order tracking and optional token cache tables.

CREATE TABLE IF NOT EXISTS bridge_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('debridge', 'bungee')),
  src_chain_id text NOT NULL,
  dst_chain_id text NOT NULL,
  src_token text NOT NULL,
  dst_token text NOT NULL,
  amount_in text NOT NULL,
  min_amount_out text,
  slippage_bps integer,
  quote_id text,
  order_id text,
  request_hash text,
  tx_hash_src text,
  tx_hash_dst text,
  status text NOT NULL DEFAULT 'created',
  route_name text,
  fees jsonb,
  metadata jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bridge_orders_user
  ON bridge_orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bridge_orders_provider_order
  ON bridge_orders(provider, order_id);
CREATE INDEX IF NOT EXISTS idx_bridge_orders_provider_request
  ON bridge_orders(provider, request_hash);
CREATE INDEX IF NOT EXISTS idx_bridge_orders_provider_tx
  ON bridge_orders(provider, tx_hash_src);

CREATE TABLE IF NOT EXISTS bridge_token_cache (
  provider text NOT NULL,
  chain_id text NOT NULL,
  address text NOT NULL,
  symbol text,
  name text,
  decimals integer,
  logo_uri text,
  tags jsonb,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (provider, chain_id, address)
);
