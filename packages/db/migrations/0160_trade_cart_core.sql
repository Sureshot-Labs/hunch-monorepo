-- Durable trade cart core schema.
-- PR 1 activates cart shell routes; later cart execution PRs use the execution
-- and order-link tables created here.

CREATE TABLE IF NOT EXISTS trade_carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'executing', 'partially_executed', 'completed', 'abandoned')),
  name text,
  source_type text NOT NULL DEFAULT 'manual'
    CHECK (source_type IN ('manual', 'proposal', 'session')),
  source_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trade_cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL REFERENCES trade_carts(id) ON DELETE CASCADE,
  client_item_id text NOT NULL,
  venue text NOT NULL CHECK (venue IN ('polymarket', 'limitless', 'kalshi')),
  market_id text,
  token_id text,
  market_slug text,
  outcome text,
  side text NOT NULL CHECK (side IN ('BUY', 'SELL')),
  order_type text CHECK (order_type IN ('GTC', 'GTD', 'FAK', 'FOK')),
  limit_price numeric CHECK (limit_price IS NULL OR (limit_price >= 0 AND limit_price <= 1)),
  amount_raw text CHECK (amount_raw IS NULL OR amount_raw ~ '^[0-9]+$'),
  allocation_weight numeric CHECK (allocation_weight IS NULL OR allocation_weight > 0),
  wallet_address text,
  signer_address text,
  funder_address text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'skipped', 'removed')),
  intent_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(intent_snapshot) = 'object'),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (cart_id, client_item_id)
);

CREATE TABLE IF NOT EXISTS trade_cart_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL REFERENCES trade_carts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'preflighting', 'needs_funding', 'executing', 'partially_failed', 'completed', 'failed', 'cancelled')),
  allocation_snapshot jsonb NOT NULL
    CHECK (jsonb_typeof(allocation_snapshot) = 'object'),
  wallet_snapshot jsonb NOT NULL
    CHECK (jsonb_typeof(wallet_snapshot) = 'object'),
  funding_plan_snapshot jsonb
    CHECK (funding_plan_snapshot IS NULL OR jsonb_typeof(funding_plan_snapshot) = 'object'),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trade_cart_execution_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_execution_id uuid NOT NULL REFERENCES trade_cart_executions(id) ON DELETE CASCADE,
  cart_item_id uuid NOT NULL REFERENCES trade_cart_items(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'preflight_failed', 'needs_funding', 'signing', 'submitting', 'submitted', 'open', 'filled', 'failed', 'skipped', 'retrying')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  active_attempt_id uuid,
  resource_keys text[] NOT NULL DEFAULT '{}'::text[],
  order_id uuid,
  venue_order_id text,
  error_code text,
  error_message text,
  preflight_snapshot jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (cart_execution_id, cart_item_id)
);

CREATE TABLE IF NOT EXISTS trade_cart_execution_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_execution_item_id uuid NOT NULL REFERENCES trade_cart_execution_items(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'signing', 'submitting', 'submitted', 'failed', 'reconciled')),
  lease_token text,
  leased_by text,
  leased_until timestamptz,
  order_id uuid,
  venue_order_id text,
  error_code text,
  error_message text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (cart_execution_item_id, attempt_number),
  UNIQUE (idempotency_key)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'trade_cart_execution_items_active_attempt_fk'
  ) THEN
    ALTER TABLE trade_cart_execution_items
      ADD CONSTRAINT trade_cart_execution_items_active_attempt_fk
      FOREIGN KEY (active_attempt_id)
      REFERENCES trade_cart_execution_attempts(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_trade_carts_user_status_updated
  ON trade_carts(user_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_trade_cart_items_cart_status_created
  ON trade_cart_items(cart_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_trade_cart_executions_cart_created
  ON trade_cart_executions(cart_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trade_cart_executions_user_status_created
  ON trade_cart_executions(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trade_cart_execution_items_execution_status
  ON trade_cart_execution_items(cart_execution_id, status);

CREATE INDEX IF NOT EXISTS idx_trade_cart_execution_items_active_attempt
  ON trade_cart_execution_items(active_attempt_id)
  WHERE active_attempt_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trade_cart_execution_attempts_item_created
  ON trade_cart_execution_attempts(cart_execution_item_id, created_at);

CREATE INDEX IF NOT EXISTS idx_trade_cart_execution_attempts_active_lease
  ON trade_cart_execution_attempts(leased_until)
  WHERE leased_until IS NOT NULL;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS cart_id uuid REFERENCES trade_carts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cart_item_id uuid REFERENCES trade_cart_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cart_execution_id uuid REFERENCES trade_cart_executions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cart_execution_item_id uuid REFERENCES trade_cart_execution_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cart_execution_attempt_id uuid REFERENCES trade_cart_execution_attempts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_cart_id ON orders(cart_id);
CREATE INDEX IF NOT EXISTS idx_orders_cart_item_id ON orders(cart_item_id);
CREATE INDEX IF NOT EXISTS idx_orders_cart_execution_id ON orders(cart_execution_id);
CREATE INDEX IF NOT EXISTS idx_orders_cart_execution_item_id ON orders(cart_execution_item_id);
CREATE INDEX IF NOT EXISTS idx_orders_cart_execution_attempt_id ON orders(cart_execution_attempt_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE trigger_name = 'update_trade_carts_updated_at'
  ) THEN
    CREATE TRIGGER update_trade_carts_updated_at
      BEFORE UPDATE ON trade_carts
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE trigger_name = 'update_trade_cart_items_updated_at'
  ) THEN
    CREATE TRIGGER update_trade_cart_items_updated_at
      BEFORE UPDATE ON trade_cart_items
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE trigger_name = 'update_trade_cart_executions_updated_at'
  ) THEN
    CREATE TRIGGER update_trade_cart_executions_updated_at
      BEFORE UPDATE ON trade_cart_executions
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE trigger_name = 'update_trade_cart_execution_items_updated_at'
  ) THEN
    CREATE TRIGGER update_trade_cart_execution_items_updated_at
      BEFORE UPDATE ON trade_cart_execution_items
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE trigger_name = 'update_trade_cart_execution_attempts_updated_at'
  ) THEN
    CREATE TRIGGER update_trade_cart_execution_attempts_updated_at
      BEFORE UPDATE ON trade_cart_execution_attempts
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
