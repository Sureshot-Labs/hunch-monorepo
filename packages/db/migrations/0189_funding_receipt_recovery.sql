create or replace function funding_guard_step_receipt_observation_update()
returns trigger
language plpgsql
as $$
declare
  corrected_mismatch boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'funding step receipt observations cannot be deleted'
      using errcode = '23514';
  end if;
  if (
    new.operation_id,
    new.step_id,
    new.attempt_id,
    new.network_id,
    new.first_seen_at,
    new.created_at
  ) is distinct from (
    old.operation_id,
    old.step_id,
    old.attempt_id,
    old.network_id,
    old.first_seen_at,
    old.created_at
  ) then
    raise exception 'funding step receipt observation identity is immutable'
      using errcode = '23514';
  end if;

  corrected_mismatch :=
    old.status = 'mismatch'
    and new.status = 'finalized'
    and new.action_match is true
    and new.canonical
    and new.failure_code is null
    and new.finalized_at is not null
    and new.reorged_at is null;

  if new.status is distinct from old.status
    and not (
      (old.status = 'pending' and new.status in (
        'confirmed',
        'finalized',
        'failed',
        'mismatch',
        'reorged'
      ))
      or (old.status = 'confirmed' and new.status in (
        'finalized',
        'failed',
        'mismatch',
        'reorged'
      ))
      or (old.status = 'finalized' and new.status = 'reorged')
      or corrected_mismatch
    ) then
    raise exception 'invalid funding step receipt transition: % -> %',
      old.status,
      new.status
      using errcode = '23514';
  end if;
  if old.status in ('failed', 'mismatch', 'reorged')
    and not corrected_mismatch
    and (
      new.status,
      new.action_match,
      new.ledger_height,
      new.block_hash,
      new.canonical,
      new.failure_code,
      new.evidence,
      new.observed_at,
      new.finalized_at,
      new.reorged_at
    ) is distinct from (
      old.status,
      old.action_match,
      old.ledger_height,
      old.block_hash,
      old.canonical,
      old.failure_code,
      old.evidence,
      old.observed_at,
      old.finalized_at,
      old.reorged_at
    ) then
    raise exception 'terminal funding step receipt observation is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

update funding_reconciliation_jobs job
set status = 'scheduled',
    due_at = now(),
    lease_owner = null,
    lease_token = null,
    lease_until = null,
    attempt_count = 0,
    last_error_code = null,
    last_error_summary = null,
    completed_at = null,
    updated_at = now()
from funding_operations operation
where operation.id = job.operation_id
  and operation.status = 'recovery_required'
  and job.status = 'dead_letter'
  and job.last_error_code = '23514'
  and job.last_error_summary =
    'invalid funding step receipt transition: mismatch -> finalized';
