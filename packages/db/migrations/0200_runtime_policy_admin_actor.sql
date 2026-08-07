-- Preserve runtime policy authorship for both legacy user admins and the
-- dedicated admin_accounts authentication system.

alter table runtime_policies
  add column if not exists created_by_admin_id uuid
    references admin_accounts(id) on delete set null;

alter table runtime_policies
  drop constraint if exists runtime_policies_single_creator;

alter table runtime_policies
  add constraint runtime_policies_single_creator
  check (num_nonnulls(created_by, created_by_admin_id) <= 1);

create index if not exists idx_runtime_policies_created_by_admin_id
  on runtime_policies(created_by_admin_id)
  where created_by_admin_id is not null;
