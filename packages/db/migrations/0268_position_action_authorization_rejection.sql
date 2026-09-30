-- Preserve identity/terminal/unknown-broadcast guards. A server-observed single
-- wallet POST denial has durable attempt evidence, unlike a browser cancellation.
-- Function replacement only: no historical data cleanup/assertions run at deploy.
create or replace function position_action_guard_operation_update()
returns trigger
language plpgsql
as $$
begin
  if (
    new.user_id,
    new.market_id,
    new.venue_id,
    new.action,
    new.position_ref,
    new.owner_binding_id,
    new.owner_address,
    new.execution_wallet_id,
    new.execution_address,
    new.execution_mode,
    new.inspection_revision,
    new.action_digest,
    new.idempotency_key,
    new.plan_snapshot,
    new.evidence_snapshot,
    new.normalized_actions,
    new.postconditions,
    new.created_at
  ) is distinct from (
    old.user_id,
    old.market_id,
    old.venue_id,
    old.action,
    old.position_ref,
    old.owner_binding_id,
    old.owner_address,
    old.execution_wallet_id,
    old.execution_address,
    old.execution_mode,
    old.inspection_revision,
    old.action_digest,
    old.idempotency_key,
    old.plan_snapshot,
    old.evidence_snapshot,
    old.normalized_actions,
    old.postconditions,
    old.created_at
  ) then
    raise exception 'position action identity and canonical plan are immutable'
      using errcode = '23514';
  end if;
  if old.status in ('completed', 'failed', 'cancelled') and (
    new.status,
    new.submission_fingerprint,
    new.broadcast_may_have_occurred,
    new.receipt_status,
    new.receipt_observed_at,
    new.postcondition_status,
    new.last_error_code,
    new.submitted_at,
    new.completed_at
  ) is distinct from (
    old.status,
    old.submission_fingerprint,
    old.broadcast_may_have_occurred,
    old.receipt_status,
    old.receipt_observed_at,
    old.postcondition_status,
    old.last_error_code,
    old.submitted_at,
    old.completed_at
  ) then
    raise exception 'terminal position action cannot be rewritten'
      using errcode = '23514';
  end if;
  if old.broadcast_may_have_occurred and not new.broadcast_may_have_occurred and not coalesce((
    old.execution_mode = 'privy_authorization'
    and old.status = 'reconcile_required'
    and old.submission_fingerprint is null
    and old.last_error_code = 'position_action_submission_reference_missing'
    and new.status = 'failed'
    and new.submission_fingerprint is null
    and new.receipt_status = 'unobserved'
    and new.last_error_code = 'position_action_authorization_rejected'
    and new.completed_at is not null
    and exists (
      select 1 from position_action_attempts rejection_attempt
      where rejection_attempt.action_operation_id = old.id
        and rejection_attempt.attempt_number = (
          select max(latest_attempt.attempt_number) from position_action_attempts latest_attempt
          where latest_attempt.action_operation_id = old.id
        )
        and rejection_attempt.outcome = 'not_broadcast'
        and not rejection_attempt.broadcast_may_have_occurred
        and rejection_attempt.submission_fingerprint is null
        and rejection_attempt.error_code = 'position_action_authorization_rejected'
        and rejection_attempt.receipt_evidence @> '{"provider":"privy","definitiveNoBroadcast":true}'::jsonb
        and rejection_attempt.receipt_evidence->>'httpStatus' in ('401', '403')
    )
  ), false) then
    raise exception 'position action broadcast evidence cannot regress'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
