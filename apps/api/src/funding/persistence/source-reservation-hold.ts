/**
 * A quote deadline limits starting an action, not an already-started action's
 * ownership of its source cash. Keep this predicate identical at admission
 * and balance projection. Final debit/refund reduction releases the row;
 * a canonical failed transaction is the only receipt that proves no debit.
 *
 * Aliases are internal SQL identifiers, never request input.
 */
export function fundingReservationHoldSql(
  reservationAlias: "balance_reservations" | "reservation" | "active_source",
): string {
  return `(
    ${reservationAlias}.expires_at > now()
    or ${fundingStartedSourceActionHoldSql(reservationAlias)}
  )`;
}

/** A destination/refund acknowledgement is not source settlement. Preserve
 * an admitted native send or explicitly bound EVM->native deposit until its
 * exact debit is recorded. Existing EVM/delegated routes keep their semantics. */
export function nativeSourceDebitPendingSql(
  reservationAlias: "balance_reservations" | "reservation",
): string {
  return `(${reservationAlias}.mode='subtract_available'
    and ((${reservationAlias}.network_id='hyperliquid:mainnet'
      and ${fundingStartedSourceActionHoldSql(reservationAlias)})
      or ${fundingStartedSourceActionHoldSql(reservationAlias, true)})
    and not exists(select 1 from funding_observations native_debit
      where native_debit.operation_id=${reservationAlias}.operation_id
        and native_debit.segment_id is not distinct from ${reservationAlias}.segment_id
        and native_debit.network_id=${reservationAlias}.network_id
        and native_debit.asset_id=${reservationAlias}.asset_id
        and native_debit.asset_decimals=${reservationAlias}.asset_decimals
        and native_debit.kind='source_debit' and native_debit.canonical
        and native_debit.finality_status='finalized'))`;
}

/** An expired quote or a stopped sibling cannot release a live source action.
 * Kept separate from the quote deadline so an entirely unsubmitted stopped leg
 * can release immediately, without weakening an uncertain send's hold. */
export function fundingStartedSourceActionHoldSql(
  reservationAlias:
    | "balance_reservations"
    | "reservation"
    | "active_source"
    | "handoff_input",
  nativeInboundDepositOnly = false,
  exactSegmentSql?: "handoff_bound_segment.id",
): string {
  return `(
      ${reservationAlias}.mode = 'subtract_available'
      and exists (
        select 1
          from funding_operation_steps source_hold_step
          join funding_operation_step_attempts source_hold_attempt
            on source_hold_attempt.step_id = source_hold_step.id
          left join funding_step_receipt_observations source_hold_receipt
            on source_hold_receipt.attempt_id = source_hold_attempt.id
         where source_hold_step.operation_id = ${reservationAlias}.operation_id
           ${exactSegmentSql ? `and source_hold_step.segment_id=${exactSegmentSql}` : ""}
           ${
             nativeInboundDepositOnly
               ? `and source_hold_step.executor_id='wallet_profile_evm_v1'
             and source_hold_step.step_kind='transaction'
             and source_hold_step.action_validation_result->>'relayNativeDestination'='hyperliquid:mainnet'
             and source_hold_step.action_validation_result->>'relayStepKind'='deposit'
             and source_hold_step.action_validation_result->>'postconditionEvidenceKind'='exact_erc20_source_debit_v1'`
               : ""
           }
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
           and (case when source_hold_step.executor_id = 'relay_hypercore_native_v1'
             and source_hold_step.step_kind = 'signature'
             and not source_hold_attempt.broadcast_may_have_occurred
             and source_hold_attempt.reference_kind is null
             and source_hold_attempt.receipt_ref_ciphertext is null
             and source_hold_attempt.receipt_ref_lookup_hmac is null
             and source_hold_attempt.lookup_key_version is null
             then funding_native_auth_attempt_bound(source_hold_step.id,
               source_hold_attempt.canonical_action_fingerprint, source_hold_attempt.executor_id,
               source_hold_attempt.actual_costs -> 'nativeSubmission')
             else false end) is not true
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
  )`;
}

/** A structural pending guard, NOT proof of a handoff or permission to settle
 * money. The receipt writer alone releases the venue input on exact owned H,
 * and its controller fence on exact bound D. Keep uncertain physical actions
 * from being released merely by a sibling/early destination or terminal cache.
 * Unsubmitted cancellation and canonical finalized failure retain recovery. */
export function polymarketNativeHandoffReservationPendingSql(
  reservationAlias: "balance_reservations" | "reservation",
): string {
  const eligibleSegment = polymarketNativeHandoffSegmentSql(reservationAlias);
  return `(${reservationAlias}.mode='subtract_available' and ${reservationAlias}.network_id='evm:137'
    and ${reservationAlias}.asset_decimals=6 and (
      (${polymarketNativeHandoffEconomicInputSql(reservationAlias)}
        and ${fundingStartedSourceActionHoldSql(reservationAlias)})
      or (${reservationAlias}.economic_role='future_credit_fence' and ${reservationAlias}.segment_id is null and exists(
        select 1 from funding_operation_segments handoff_bound_segment where ${eligibleSegment}
          and ${reservationAlias}.location_id=handoff_bound_segment.source_snapshot#>>'{location,locationId}'
          and (${fundingStartedSourceActionHoldSql(reservationAlias, true, "handoff_bound_segment.id")}
            or exists(select 1 from balance_reservations handoff_input
              where handoff_input.operation_id=${reservationAlias}.operation_id and handoff_input.segment_id=handoff_bound_segment.id
                and handoff_input.user_id=${reservationAlias}.user_id and handoff_input.economic_role='source_input'
                and handoff_input.mode='subtract_available' and handoff_input.state='active'
                and ${fundingStartedSourceActionHoldSql("handoff_input")}))))
    ))`;
}

function polymarketNativeHandoffSegmentSql(
  reservationAlias: "balance_reservations" | "reservation",
): string {
  return `handoff_bound_segment.operation_id=${reservationAlias}.operation_id
    and handoff_bound_segment.provider_id='relay'
    and handoff_bound_segment.quoted_expected_output#>>'{asset,networkId}'='hyperliquid:mainnet'
    and handoff_bound_segment.source_snapshot#>>'{location,kind}'='wallet'
    and handoff_bound_segment.quoted_input#>>'{asset,networkId}'=${reservationAlias}.network_id
    and lower(handoff_bound_segment.quoted_input#>>'{asset,assetId}')=lower(${reservationAlias}.asset_id)
    and handoff_bound_segment.quoted_input#>>'{asset,decimals}'=${reservationAlias}.asset_decimals::text`;
}

/** Structural economic-input shape only, not evidence of any transfer. Its
 * segment's controller debit must never be reported as a venue physical debit. */
export function polymarketNativeHandoffEconomicInputSql(
  reservationAlias: "balance_reservations" | "reservation",
): string {
  return `(${reservationAlias}.mode='subtract_available' and ${reservationAlias}.network_id='evm:137'
    and ${reservationAlias}.asset_decimals=6 and ${reservationAlias}.economic_role='source_input' and exists(
        select 1 from funding_operation_segments handoff_bound_segment where ${polymarketNativeHandoffSegmentSql(reservationAlias)}
          and handoff_bound_segment.id=${reservationAlias}.segment_id
          and ${reservationAlias}.location_id is distinct from handoff_bound_segment.source_snapshot#>>'{location,locationId}'))`;
}

export function fundingPhysicalSourcePendingSql(
  reservationAlias: "balance_reservations" | "reservation",
): string {
  return `(${nativeSourceDebitPendingSql(reservationAlias)} or ${polymarketNativeHandoffReservationPendingSql(reservationAlias)})`;
}
