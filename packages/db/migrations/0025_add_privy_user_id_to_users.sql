-- Add Privy DID to local users for stable identity across wallet link/unlink events.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS privy_user_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_privy_user_id
  ON users(privy_user_id)
  WHERE privy_user_id IS NOT NULL;

