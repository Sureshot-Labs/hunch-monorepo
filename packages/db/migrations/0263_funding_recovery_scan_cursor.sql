-- Bounded, restart-safe traversal; no historical data rewrite or rollout guard.
create table if not exists funding_recovery_scan_cursor (
  cursor_name text primary key,
  last_operation_id uuid,
  updated_at timestamptz not null default now()
);
insert into funding_recovery_scan_cursor(cursor_name)
values ('stopped_evidence_v1') on conflict do nothing;
