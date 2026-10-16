/* no-transaction */
-- Derived scheduling only. Preserve the original queue index for old readers.
-- No legacy row is rejected or financially settled by this index.
drop index concurrently if exists hip4_order_reconcile_lanes_idx;
create index concurrently hip4_order_reconcile_lanes_idx
  on hip4_order_submissions((coalesce(
    reconcile_error is null
    and order_observation @> '{"terminal":true,"balanceBarrier":{"state":"terminal_observed"}}'::jsonb
    and fills_observation @> '{"fullQuantityObserved":true,"feeCoverage":"known"}'::jsonb
    and jsonb_typeof(fills_observation->'executionSummary')='object',false)),reconcile_after,action_id)
  where state<>'rejected' and debit_asset_id is not null;
