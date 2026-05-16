CREATE TABLE IF NOT EXISTS agent_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grant_id uuid NOT NULL REFERENCES agent_grants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (
    kind IN ('trade', 'bridge', 'cancel_order', 'redeem')
  ),
  status text NOT NULL CHECK (
    status IN ('pending_confirmation', 'blocked', 'expired', 'cancelled')
  ),
  idempotency_key text NOT NULL,
  venue text,
  wallet_address text,
  market_id text,
  event_id text,
  order_id text,
  token_id text,
  request_payload jsonb NOT NULL,
  resolved_payload jsonb NOT NULL DEFAULT '{}',
  funding_plan jsonb NOT NULL DEFAULT '{}',
  policy_result jsonb NOT NULL DEFAULT '{}',
  blockers text[] NOT NULL DEFAULT '{}',
  warnings text[] NOT NULL DEFAULT '{}',
  review_token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (grant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_intents_user_created
  ON agent_intents(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_intents_grant_created
  ON agent_intents(grant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_intents_status_expiry
  ON agent_intents(status, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_intents_review_token_hash
  ON agent_intents(review_token_hash);

DROP TRIGGER IF EXISTS update_agent_intents_updated_at ON agent_intents;
CREATE TRIGGER update_agent_intents_updated_at
  BEFORE UPDATE ON agent_intents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
