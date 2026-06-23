-- Latest on-chain identity and liquid balance context for wallet-intel rows.

CREATE TABLE IF NOT EXISTS wallet_onchain_state (
  wallet_id uuid PRIMARY KEY REFERENCES wallets(id) ON DELETE CASCADE,
  chain text NOT NULL,
  wallet_address text NOT NULL,
  wallet_kind text,
  owner_wallet_id uuid REFERENCES wallets(id) ON DELETE SET NULL,
  owner_address text,
  owner_source text,
  owner_confidence text,
  identity_resolved_at timestamptz,
  wallet_balances jsonb,
  owner_balances jsonb,
  wallet_usd_like_balance numeric,
  owner_usd_like_balance numeric,
  balance_as_of timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_onchain_state_owner_wallet
  ON wallet_onchain_state(owner_wallet_id)
  WHERE owner_wallet_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wallet_onchain_state_owner_address
  ON wallet_onchain_state(chain, lower(owner_address))
  WHERE owner_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wallet_onchain_state_balance_as_of
  ON wallet_onchain_state(balance_as_of DESC);

CREATE INDEX IF NOT EXISTS idx_wallet_onchain_state_wallet_usd_like
  ON wallet_onchain_state(wallet_usd_like_balance DESC)
  WHERE wallet_usd_like_balance IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wallet_onchain_state_owner_usd_like
  ON wallet_onchain_state(owner_usd_like_balance DESC)
  WHERE owner_usd_like_balance IS NOT NULL;
