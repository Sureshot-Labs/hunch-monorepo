-- Nonces for manual wallet linking verification.

CREATE TABLE IF NOT EXISTS user_wallet_link_nonces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_address text NOT NULL,
  wallet_type text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_link_nonces_unique
  ON user_wallet_link_nonces(user_id, wallet_type, wallet_address);

CREATE INDEX IF NOT EXISTS idx_wallet_link_nonces_expires
  ON user_wallet_link_nonces(expires_at);
