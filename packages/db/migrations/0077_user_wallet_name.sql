-- Add optional per-user wallet display name for linked auth wallets.
ALTER TABLE user_wallets
  ADD COLUMN IF NOT EXISTS name text;
