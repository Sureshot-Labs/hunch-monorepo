/* no-transaction */
-- Capacity reads must seek unaccounted orders, not scan all terminal history.
-- Malformed/legacy proof remains unaccounted, not a migration-time failure.
-- Sentinel is above every valid JS safe timestamp, NOT a product threshold.
-- Retry replaces this migration's own possibly invalid concurrent artifact.
drop index concurrently if exists hip4_order_submissions_capacity_barrier_idx;
create index concurrently hip4_order_submissions_capacity_barrier_idx
  on hip4_order_submissions(signer_address,debit_asset_id,
    (coalesce((case when order_observation@>'{"terminal":true,"balanceBarrier":{"state":"terminal_observed"}}'::jsonb
      and jsonb_typeof(order_observation#>'{balanceBarrier,responseAt}')='number'
      and (order_observation#>>'{balanceBarrier,responseAt}') ~ '^(0|[1-9][0-9]*)$'
      then case when (order_observation#>>'{balanceBarrier,responseAt}')::numeric<=9007199254740991
        then (order_observation#>>'{balanceBarrier,responseAt}')::numeric end end),9007199254740992)))
  where state<>'rejected';
