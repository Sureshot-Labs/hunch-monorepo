CREATE TABLE IF NOT EXISTS agent_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  client_name text,
  client_version text,
  client_kind text,
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  wallet_addresses text[] NOT NULL DEFAULT '{}',
  venues text[] NOT NULL DEFAULT '{}',
  allowed_chains text[] NOT NULL DEFAULT '{}',
  allowed_assets text[] NOT NULL DEFAULT '{}',
  confirmation_mode text NOT NULL DEFAULT 'always'
    CHECK (confirmation_mode IN ('always', 'policy', 'never')),
  limits jsonb NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_grants_token_hash_unique
  ON agent_grants(token_hash);

CREATE INDEX IF NOT EXISTS idx_agent_grants_user_active
  ON agent_grants(user_id, is_active, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_grants_active_expiry
  ON agent_grants(expires_at)
  WHERE is_active = true;

DROP TRIGGER IF EXISTS update_agent_grants_updated_at ON agent_grants;
CREATE TRIGGER update_agent_grants_updated_at
  BEFORE UPDATE ON agent_grants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS agent_device_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash text NOT NULL UNIQUE,
  approval_token_hash text NOT NULL UNIQUE,
  status text NOT NULL CHECK (
    status IN ('pending', 'approved', 'denied', 'expired', 'token_issued')
  ),
  requested_scopes text[] NOT NULL DEFAULT '{}',
  requested_wallet_addresses text[] NOT NULL DEFAULT '{}',
  requested_venues text[] NOT NULL DEFAULT '{}',
  requested_limits jsonb NOT NULL DEFAULT '{}',
  approved_scopes text[],
  approved_wallet_addresses text[],
  approved_venues text[],
  approved_limits jsonb,
  grant_expires_at timestamptz,
  client_name text,
  client_version text,
  client_kind text,
  metadata jsonb NOT NULL DEFAULT '{}',
  approved_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  approved_grant_id uuid REFERENCES agent_grants(id) ON DELETE SET NULL,
  poll_count integer NOT NULL DEFAULT 0,
  approval_attempts integer NOT NULL DEFAULT 0,
  last_polled_at timestamptz,
  approved_at timestamptz,
  denied_at timestamptz,
  token_issued_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_device_authorizations_status_expiry
  ON agent_device_authorizations(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_agent_device_authorizations_grant
  ON agent_device_authorizations(approved_grant_id);

CREATE INDEX IF NOT EXISTS idx_agent_device_authorizations_created
  ON agent_device_authorizations(created_at DESC);

CREATE TABLE IF NOT EXISTS agent_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  grant_id uuid REFERENCES agent_grants(id) ON DELETE SET NULL,
  device_authorization_id uuid REFERENCES agent_device_authorizations(id)
    ON DELETE SET NULL,
  event_type text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  ip_address text,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_audit_events_user_created
  ON agent_audit_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_audit_events_grant_created
  ON agent_audit_events(grant_id, created_at DESC);
