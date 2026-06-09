/* no-transaction */
SET statement_timeout = 0;

-- Speeds up linked owner lookup for EVM wallets while keeping Solana
-- addresses exact/case-sensitive.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallets_evm_chain_lower_address
  ON wallets (chain, (lower(address)))
  INCLUDE (id, address, label)
  WHERE chain <> 'solana';
