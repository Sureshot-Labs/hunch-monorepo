/* no-transaction */

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_positions_hidden_own_evm_venue_token_lower_wallet
  ON positions (venue, token_id, lower(wallet_address))
  WHERE position_scope = 'own'
    AND is_hidden = true
    AND venue IN ('polymarket', 'limitless')
    AND wallet_address IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_positions_hidden_own_kalshi_token_wallet
  ON positions (token_id, wallet_address)
  WHERE position_scope = 'own'
    AND is_hidden = true
    AND venue = 'kalshi'
    AND wallet_address IS NOT NULL;
