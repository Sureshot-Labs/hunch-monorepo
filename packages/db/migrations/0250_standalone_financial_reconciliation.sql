-- Independent preparation/redemption journals need fair, restart-safe polling.
-- These fields schedule evidence reads only; they never authorize submission.
alter table funding_preparation_runs
  add column reconciliation_next_attempt_at timestamptz not null default now(),
  add column reconciliation_lease_until timestamptz,
  add column reconciliation_lease_token uuid;

alter table position_action_operations
  add column reconciliation_next_attempt_at timestamptz not null default now(),
  add column reconciliation_lease_until timestamptz,
  add column reconciliation_lease_token uuid;

create index funding_preparation_runs_reconciliation_due_idx
  on funding_preparation_runs (reconciliation_next_attempt_at, id)
  where status in ('submitted', 'ambiguous');

create index position_action_operations_reconciliation_due_idx
  on position_action_operations (reconciliation_next_attempt_at, id)
  where action = 'redeem'
    and status in ('submitting', 'submitted', 'reconcile_required', 'confirmed', 'completed');
