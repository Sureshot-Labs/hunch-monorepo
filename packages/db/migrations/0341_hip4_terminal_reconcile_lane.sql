/* no-transaction */
-- Scheduling only: normal terminal partial/zero fills must not stay in the
-- hot queue forever. Preserve old-reader indexes and every financial fact.
-- Successful bounded scan exhaustion is NOT proof of complete fill history.
create index concurrently hip4_order_terminal_reconcile_lanes_idx
  on hip4_order_submissions((coalesce(
    reconcile_error is null
    and order_observation @> '{"terminal":true,"balanceBarrier":{"state":"terminal_observed"}}'::jsonb
    and (
      (fills_observation @> '{"fullQuantityObserved":true,"feeCoverage":"known"}'::jsonb
        and jsonb_typeof(fills_observation->'executionSummary')='object')
      or (
        fills_observation @> '{"repair":{"version":1,"source":"hyperliquid_user_fills_by_time","nextTime":null,"lastError":null}}'::jsonb
        and jsonb_typeof(fills_observation#>'{repair,lastSuccessAt}')='string'
        and case
          when jsonb_typeof(fills_observation#>'{repair,coveredThrough}')='number'
            and jsonb_typeof(order_observation->'observedStatusTime')='number'
          then (fills_observation#>>'{repair,coveredThrough}')::numeric >=
            (order_observation->>'observedStatusTime')::numeric
          else false end
      )
    ),false)),reconcile_after,action_id)
  where state<>'rejected' and debit_asset_id is not null;
