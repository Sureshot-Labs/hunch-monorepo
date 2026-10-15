import {
  hip4TerminalOrderBarrierMsSql,
  hip4OpenOrderBarrierMsSql,
} from "./hip4-order-holds.js";

// Read projection only: native terminal status must not overwrite the execution
// ledger or release funding. An ACK, cancel ACK or unsigned action is not a fill.
export const HIP4_NATIVE_ORDER_READ_JOINS = `
  join hip4_order_actions native_action on native_action.order_id=o.id
    and native_action.action_kind='order'
  join hip4_order_submissions native_submission on native_submission.action_id=native_action.id
  cross join lateral (
    select ${hip4TerminalOrderBarrierMsSql("native_submission.order_observation")} as terminal_ms
  ) native_barrier
  cross join lateral (
    select coalesce(native_barrier.terminal_ms<=extract(epoch from statement_timestamp())*1000,false) as terminal_confirmed
  ) native_terminal
  cross join lateral (
    select case
      when native_submission.state='rejected' then 'rejected'
      when native_terminal.terminal_confirmed then case
        when native_submission.order_observation->>'status'='filled' then 'filled'
        when native_submission.order_observation->>'status' in
          ('canceled','scheduledCancel','delistedCanceled','selfTradeCanceled','outcomeSettledCanceled','internalCancel') then 'cancelled'
        else 'closed' end
      else o.status end as display_status
  ) native_state
`;

// orders.filled_size starts at zero even before the first observation. Unknown
// execution history must not turn that default into a confirmed zero-fill fact.
export const HIP4_NATIVE_ORDER_FILLED_SIZE = `(case when o.filled_size>0
  or native_submission.state='rejected'
  or jsonb_typeof(native_submission.fills_observation->'quantityRaw')='string'
  then o.filled_size end)`;

export const HIP4_NATIVE_ORDER_READ_FACTS = `jsonb_build_object(
  'cloid',native_action.cloid,
  'submissionState',native_submission.state,
  'nativeStatus',native_submission.order_observation->>'status',
  'openConfirmed',native_submission.state<>'rejected' and coalesce(${hip4OpenOrderBarrierMsSql("native_submission.order_observation")}<=extract(epoch from statement_timestamp())*1000,false),
  'terminalConfirmed',native_terminal.terminal_confirmed,
  'terminalObservedAt',case when native_terminal.terminal_confirmed
    then to_timestamp(native_barrier.terminal_ms::double precision/1000) end,
  'filledQuantity',${HIP4_NATIVE_ORDER_FILLED_SIZE}::text,
  'fullQuantityObserved',coalesce(native_submission.fills_observation@>'{"fullQuantityObserved":true}'::jsonb,false),
  'fillHistoryCoverage','not_asserted'
)`;

// A provider open-order snapshot is an additional source, not another order.
// Exact owner + venue OID + environment + token only; never amount/time matching.
// Suppress also after native termination, so an older snapshot cannot revive it.
export const HIP4_OBSERVED_ORDER_NOT_NATIVE = `not exists (
  select 1 from orders native_order
  join hip4_order_actions native_action on native_action.order_id=native_order.id
    and native_action.action_kind='order'
  join hip4_order_submissions native_submission on native_submission.action_id=native_action.id
  where native_order.user_id=$1 and native_order.venue='hyperliquid'
    and native_order.venue_order_id=e.oid::text
    and native_action.environment=e.environment
    and native_action.signer_address=e.account_address
    and native_action.token_id=('hyperliquid:' || e.environment || ':' || substring(e.coin from 2))
)`;
