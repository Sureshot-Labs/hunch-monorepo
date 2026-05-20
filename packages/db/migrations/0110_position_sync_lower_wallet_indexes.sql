/* no-transaction */

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_positions_sync_user_venue_lower_wallet_scope
  ON positions(user_id, venue, lower(wallet_address), position_scope);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_positions_sync_active_lower_wallet_token
  ON positions(user_id, venue, lower(wallet_address), position_scope, token_id)
  WHERE side <> 'FLAT'
    AND size > 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_sync_user_venue_lower_wallet_recent
  ON orders(user_id, venue, lower(wallet_address), (coalesce(filled_at, last_update, posted_at)))
  WHERE token_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_sync_user_venue_lower_signer_recent
  ON orders(user_id, venue, lower(signer_address), (coalesce(filled_at, last_update, posted_at)))
  WHERE token_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_venue_credentials_active_lower_wallet
  ON user_venue_credentials(user_id, venue, lower(wallet_address))
  WHERE is_active = true;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_venue_credentials_active_lower_funder
  ON user_venue_credentials(user_id, venue, lower(funder_address))
  WHERE is_active = true
    AND funder_address IS NOT NULL;
