// Cadence only, never a financial settlement/absence predicate. A terminal
// partial/zero fill can never reach its ORIGINAL full quantity. After a
// successful bounded scan through its terminal time it remains observable in
// the existing cold lane, without changing history coverage, fees or holds.
// Keep the expression identical to the additive queue index migration.
export const HIP4_COMPLETED_ORDER_OBSERVATION_SQL = `coalesce(
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
  ),false)`;
