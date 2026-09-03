-- Step state is a materialized lifecycle projection.  The immutable action
-- plan and append-only attempt/receipt evidence remain the authority; a
-- cached state must be allowed to move directly to the projection after late
-- evidence or reconciliation, instead of replaying an obsolete transition
-- graph.
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
  return new;
end;
$$;
