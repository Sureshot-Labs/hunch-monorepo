/* no-transaction */
-- Snapshot cash remains suppressed after route completion until a newer source
-- observation arrives. Index the native post-snapshot tail, not lifetime user
-- history. No existing row is rewritten or required to pass a new assertion.
create index concurrently if not exists funding_observations_native_source_tail_idx
  on funding_observations
    (lower(from_address), (coalesce(finalized_at, observed_at)))
  where network_id='hyperliquid:mainnet'
    and asset_id='0x6d1e7cde53ba9467b783cb7c530ce054'
    and kind='source_debit' and canonical and finality_status='finalized';
