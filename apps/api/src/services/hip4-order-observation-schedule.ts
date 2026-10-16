// Cadence only, never a financial settlement/absence predicate. Unknown,
// partial or fee-incomplete orders retain the ordinary hot repair path.
// Keep the expression identical to the additive queue index migration.
export const HIP4_COMPLETED_ORDER_OBSERVATION_SQL = `coalesce(
  reconcile_error is null
  and order_observation @> '{"terminal":true,"balanceBarrier":{"state":"terminal_observed"}}'::jsonb
  and fills_observation @> '{"fullQuantityObserved":true,"feeCoverage":"known"}'::jsonb
  and jsonb_typeof(fills_observation->'executionSummary')='object',false)`;
