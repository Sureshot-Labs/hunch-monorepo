/* no-transaction */
-- Provider retention/unknownOid is not a contradiction of an already exact,
-- non-invalidated terminal observation. Keep its diagnostic and financial
-- facts, but do not put all retained history back into permanent hot polling.
-- Earlier-reader indexes remain available. No historical rows are classified.
create index concurrently hip4_order_retained_terminal_lanes_idx
  on hip4_order_submissions((coalesce(
    (reconcile_error is null or reconcile_error='order_not_observed')
    and order_observation @> '{"terminal":true,"balanceBarrier":{"state":"terminal_observed"}}'::jsonb
    and (
      (fills_observation @> '{"fullQuantityObserved":true,"feeCoverage":"known"}'::jsonb
        and (jsonb_typeof(fills_observation->'executionSummary')='object'
          or reconcile_error='order_not_observed'))
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
