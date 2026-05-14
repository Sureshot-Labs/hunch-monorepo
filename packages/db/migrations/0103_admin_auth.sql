CREATE TABLE IF NOT EXISTS admin_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text,
  totp_secret_enc text,
  totp_enabled boolean NOT NULL DEFAULT false,
  last_totp_counter bigint,
  status text NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'enrolled', 'active', 'disabled')),
  role text CHECK (role IS NULL OR role IN ('admin', 'sadmin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  invited_at timestamptz NOT NULL DEFAULT now(),
  enrolled_at timestamptz,
  activated_at timestamptz,
  disabled_at timestamptz,
  last_login_at timestamptz,
  password_changed_at timestamptz,
  totp_confirmed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_accounts_email_lower
  ON admin_accounts (lower(email));

CREATE INDEX IF NOT EXISTS idx_admin_accounts_status_role
  ON admin_accounts (status, role);

CREATE TABLE IF NOT EXISTS admin_enrollment_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_enrollment_tokens_admin_id_created
  ON admin_enrollment_tokens (admin_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_enrollment_tokens_active
  ON admin_enrollment_tokens (token_hash, expires_at)
  WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS admin_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
  session_token_hash text NOT NULL UNIQUE,
  csrf_token text NOT NULL,
  ip_address text,
  user_agent text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_accessed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin_id
  ON admin_sessions (admin_id);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_active
  ON admin_sessions (session_token_hash, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS admin_auth_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid REFERENCES admin_accounts(id) ON DELETE SET NULL,
  email text,
  attempt_type text NOT NULL,
  success boolean NOT NULL,
  ip_address text,
  user_agent text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_auth_attempts_email_created
  ON admin_auth_attempts (lower(email), created_at DESC)
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admin_auth_attempts_admin_created
  ON admin_auth_attempts (admin_id, created_at DESC)
  WHERE admin_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admin_auth_attempts_created
  ON admin_auth_attempts (created_at DESC);

DROP TRIGGER IF EXISTS update_admin_accounts_updated_at ON admin_accounts;
CREATE TRIGGER update_admin_accounts_updated_at
  BEFORE UPDATE ON admin_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
