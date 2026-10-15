/* no-transaction */
-- A terminal destination/refund cannot restore funds in an older source-wallet
-- snapshot. Keep this tail indexed by exact physical asset/owner/time. No legacy
-- row is rewritten and no data-dependent assertion can stop the migration.
create index concurrently if not exists funding_observations_evm_source_tail_idx
  on funding_observations
    (network_id, lower(asset_id), lower(from_address), (coalesce(finalized_at, observed_at)))
  where network_id in ('evm:8453','evm:137')
    and asset_decimals=6
    and kind='source_debit' and canonical and finality_status='finalized';
