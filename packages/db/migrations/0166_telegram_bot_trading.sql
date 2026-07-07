CREATE TABLE IF NOT EXISTS telegram_bot_trading_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  telegram_user_id text NOT NULL REFERENCES user_telegram_accounts(telegram_user_id) ON DELETE CASCADE,
  privy_user_id text,
  wallet_address text NOT NULL,
  wallet_chain text NOT NULL CHECK (wallet_chain IN ('ethereum', 'solana')),
  privy_wallet_id text,
  enabled boolean NOT NULL DEFAULT true,
  enabled_venues text[] NOT NULL DEFAULT ARRAY[]::text[],
  max_amount_usd numeric(18, 6),
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  disabled_at timestamptz,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telegram_bot_trading_authorizations_enabled_venues_check
    CHECK (enabled_venues <@ ARRAY['polymarket', 'limitless', 'kalshi']::text[]),
  CONSTRAINT telegram_bot_trading_authorizations_chain_venues_check
    CHECK (
      (wallet_chain = 'ethereum' AND enabled_venues <@ ARRAY['polymarket', 'limitless']::text[])
      OR (wallet_chain = 'solana' AND enabled_venues <@ ARRAY['kalshi']::text[])
    ),
  CONSTRAINT telegram_bot_trading_authorizations_max_amount_check
    CHECK (max_amount_usd IS NULL OR max_amount_usd > 0),
  CONSTRAINT telegram_bot_trading_authorizations_telegram_chain_unique
    UNIQUE (telegram_user_id, wallet_chain)
);

CREATE INDEX IF NOT EXISTS idx_telegram_bot_trading_authorizations_user
  ON telegram_bot_trading_authorizations(user_id);

CREATE INDEX IF NOT EXISTS idx_telegram_bot_trading_authorizations_enabled
  ON telegram_bot_trading_authorizations(enabled)
  WHERE enabled = true;

CREATE INDEX IF NOT EXISTS idx_telegram_bot_trading_authorizations_wallet
  ON telegram_bot_trading_authorizations(lower(wallet_address));

CREATE TABLE IF NOT EXISTS telegram_trade_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  authorization_id uuid REFERENCES telegram_bot_trading_authorizations(id) ON DELETE SET NULL,
  chat_id text,
  telegram_message_id bigint,
  callback_query_id text,
  action text NOT NULL CHECK (action IN ('buy', 'sell')),
  venue text NOT NULL CHECK (venue IN ('polymarket', 'limitless', 'kalshi')),
  market_id text NOT NULL REFERENCES unified_markets(id) ON DELETE RESTRICT,
  event_id text,
  side text CHECK (side IN ('YES', 'NO')),
  amount_usd numeric(18, 6),
  sell_percent numeric(10, 6),
  shares_raw text,
  status text NOT NULL CHECK (
    status IN (
      'draft',
      'previewed',
      'confirming',
      'executing',
      'submitted',
      'filled',
      'failed',
      'expired',
      'cancelled'
    )
  ),
  quote_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  execution_id uuid REFERENCES executions(id) ON DELETE SET NULL,
  venue_order_id text,
  tx_signature text,
  prepared_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text NOT NULL UNIQUE,
  CONSTRAINT telegram_trade_intents_buy_amount_check
    CHECK ((action = 'buy' AND amount_usd IS NOT NULL AND amount_usd > 0) OR action = 'sell'),
  CONSTRAINT telegram_trade_intents_terminal_ref_check
    CHECK (
      status NOT IN ('submitted', 'filled')
      OR order_id IS NOT NULL
      OR execution_id IS NOT NULL
      OR venue_order_id IS NOT NULL
      OR tx_signature IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_telegram_trade_intents_telegram_status
  ON telegram_trade_intents(telegram_user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_trade_intents_market_created
  ON telegram_trade_intents(market_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_trade_intents_expires
  ON telegram_trade_intents(expires_at)
  WHERE status IN ('draft', 'previewed', 'confirming');

CREATE INDEX IF NOT EXISTS idx_telegram_trade_intents_stale_ephemeral
  ON telegram_trade_intents(market_id, expires_at)
  WHERE status IN ('draft', 'previewed', 'confirming', 'expired', 'cancelled', 'failed')
    AND order_id IS NULL
    AND execution_id IS NULL
    AND venue_order_id IS NULL
    AND tx_signature IS NULL;

CREATE INDEX IF NOT EXISTS idx_telegram_trade_intents_executing_stale
  ON telegram_trade_intents(updated_at)
  WHERE status = 'executing';

CREATE INDEX IF NOT EXISTS idx_telegram_trade_intents_venue_order
  ON telegram_trade_intents(venue, venue_order_id)
  WHERE venue_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_telegram_trade_intents_venue_tx
  ON telegram_trade_intents(venue, tx_signature)
  WHERE tx_signature IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_telegram_trade_intents_user_created
  ON telegram_trade_intents(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;
