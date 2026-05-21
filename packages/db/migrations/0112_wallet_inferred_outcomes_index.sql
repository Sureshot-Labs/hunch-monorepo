/* no-transaction */
SET lock_timeout = '5s';
SET statement_timeout = 0;

-- Supports wallet-intel inferred outcome refresh:
-- latest positive wallet/market/outcome snapshots for bounded wallet batches.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_position_snapshots_wallet_market_side_time_pos
  ON wallet_position_snapshots (wallet_id, market_id, outcome_side, snapshot_at DESC)
  WHERE shares > 0;

-- Supports wallet position-history pagination by reducing full-row snapshot
-- scans to index-only positive position key scans plus latest-row probes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wps_wallet_venue_market_side_time_pos_cover
  ON wallet_position_snapshots (wallet_id, venue, market_id, outcome_side, snapshot_at DESC)
  INCLUDE (shares, size_usd, price)
  WHERE coalesce(shares, 0) > 0
     OR greatest(coalesce(size_usd, 0), abs(coalesce(shares, 0) * coalesce(price, 0))) > 0;
