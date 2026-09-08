/**
 * A quote deadline limits starting an action, not an already-started action's
 * ownership of its source cash. Keep this predicate identical at admission
 * and balance projection. Final debit/refund reduction releases the row;
 * a canonical failed transaction is the only receipt that proves no debit.
 *
 * Aliases are internal SQL identifiers, never request input.
 */
export function fundingReservationHoldSql(
  reservationAlias: "balance_reservations" | "reservation",
): string {
  return `(
    ${reservationAlias}.expires_at > now()
    or (
      ${reservationAlias}.mode = 'subtract_available'
      and exists (
        select 1
          from funding_operation_steps source_hold_step
          join funding_operation_step_attempts source_hold_attempt
            on source_hold_attempt.step_id = source_hold_step.id
          left join funding_step_receipt_observations source_hold_receipt
            on source_hold_receipt.attempt_id = source_hold_attempt.id
         where source_hold_step.operation_id = ${reservationAlias}.operation_id
           and (
             ${reservationAlias}.segment_id is null
             or source_hold_step.segment_id = ${reservationAlias}.segment_id
             or (
               source_hold_step.segment_id is null
               and exists (
                 with recursive source_lane_steps as (
                   select lane_step.id, lane_step.depends_on_step_id
                     from funding_operation_steps lane_step
                    where lane_step.operation_id = ${reservationAlias}.operation_id
                      and lane_step.segment_id = ${reservationAlias}.segment_id
                   union
                   select parent_step.id, parent_step.depends_on_step_id
                     from funding_operation_steps parent_step
                     join source_lane_steps child_step
                       on child_step.depends_on_step_id = parent_step.id
                    where parent_step.operation_id = ${reservationAlias}.operation_id
                 )
                 select 1 from source_lane_steps
                  where source_lane_steps.id = source_hold_step.id
               )
             )
           )
           and (
             source_hold_attempt.outcome in ('started', 'submitted', 'ambiguous', 'succeeded')
             or source_hold_attempt.broadcast_may_have_occurred
           )
           and (
             source_hold_receipt.status = 'failed'
             and source_hold_receipt.canonical
             and source_hold_receipt.evidence ->> 'failureFinalized' = 'true'
           ) is not true
           and (
             source_hold_receipt.status = 'finalized'
             and source_hold_receipt.canonical
             and source_hold_receipt.action_match
             and (
               source_hold_step.step_kind in ('approval', 'signature')
               or source_hold_step.action_validation_result ->> 'relayStepKind'
                    in ('approve', 'cleanup')
             )
           ) is not true
      )
    )
  )`;
}
