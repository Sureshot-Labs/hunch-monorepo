/* no-transaction */
SET statement_timeout = 0;

-- Speeds up safe-owner lookup used by whale/listing routes:
-- w2.chain = w.chain
-- and w2.metadata->>'kind' = 'safe_owner'
-- and w2.metadata->>'derivedFrom' = w.address
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallets_safe_owner_chain_derived_from
  ON wallets (chain, ((metadata->>'derivedFrom')))
  INCLUDE (id, address, label)
  WHERE metadata->>'kind' = 'safe_owner';

-- Speeds up category filters:
-- wp.profile->'categories' ?| $categories
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_profiles_categories_gin
  ON wallet_profiles
  USING gin ((profile->'categories'));
