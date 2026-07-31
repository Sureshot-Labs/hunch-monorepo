-- Committed funding operations have a finite client-action lifetime.
-- Expiry is enforced only while reconciliation proves that no action may have
-- broadcast; submitted or ambiguous external effects continue reconciling.

alter table funding_operations
  add column expires_at timestamptz;

update funding_operations
set expires_at = created_at + interval '15 minutes',
    version = version + 1
where expires_at is null;

set constraints all immediate;

alter table funding_operations
  alter column expires_at set not null,
  add constraint funding_operations_expiry_check
    check (expires_at > created_at);

create index funding_operations_expiry_idx
  on funding_operations (expires_at)
  where status in ('awaiting_user', 'awaiting_external_funds', 'in_progress');
