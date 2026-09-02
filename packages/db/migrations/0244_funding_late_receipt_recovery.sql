-- A finalized failure normally re-arms a funding action. If later canonical
-- evidence invalidates that failure, receipt reconciliation must be able to
-- stop the retry immediately and move the step back into explicit recovery.
-- No planned action fields or historical rows are changed by this migration.

create or replace function funding_prevent_step_plan_mutation()
returns trigger
language plpgsql
as $$
begin
  if (
    new.operation_id,
    new.segment_id,
    new.ordinal,
    new.step_kind,
    new.action_fingerprint,
    new.executor_id,
    new.payer_requirement,
    new.depends_on_step_id,
    new.normalized_action,
    new.action_validation_result,
    new.created_at
  ) is distinct from (
    old.operation_id,
    old.segment_id,
    old.ordinal,
    old.step_kind,
    old.action_fingerprint,
    old.executor_id,
    old.payer_requirement,
    old.depends_on_step_id,
    old.normalized_action,
    old.action_validation_result,
    old.created_at
  ) then
    raise exception 'funding operation step plan is immutable'
      using errcode = '23514';
  end if;
  if new.state is distinct from old.state
    and not (
      (old.state = 'planned' and new.state in (
        'action_required',
        'submitted',
        'reconcile_required',
        'failed',
        'cancelled'
      ))
      or (old.state = 'action_required' and new.state in (
        'submitted',
        'reconcile_required',
        'recovery_required',
        'failed',
        'cancelled'
      ))
      or (old.state = 'submitted' and new.state in (
        'action_required',
        'succeeded',
        'reconcile_required',
        'recovery_required',
        'failed'
      ))
      or (old.state = 'reconcile_required' and new.state in (
        'action_required',
        'submitted',
        'succeeded',
        'recovery_required',
        'failed'
      ))
      or (old.state = 'succeeded' and new.state = 'recovery_required')
      or (old.state = 'recovery_required' and new.state in (
        'action_required',
        'succeeded',
        'failed'
      ))
    ) then
    raise exception 'invalid funding operation step state transition: % -> %',
      old.state,
      new.state
      using errcode = '23514';
  end if;
  return new;
end;
$$;
