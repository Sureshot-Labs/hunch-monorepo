-- Exact-attempt certainty is separate from observational repair leases.
alter table copy_attributions
  add column submission_attempt_token uuid not null default gen_random_uuid(),
  add column submission_started_at timestamptz;
