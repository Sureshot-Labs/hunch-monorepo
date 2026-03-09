ALTER TABLE users
  ADD COLUMN IF NOT EXISTS privy_bind_grant_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS privy_bind_grant_note text;

CREATE INDEX IF NOT EXISTS idx_users_privy_bind_grant_expires_at
  ON users (privy_bind_grant_expires_at)
  WHERE privy_bind_grant_expires_at IS NOT NULL;
