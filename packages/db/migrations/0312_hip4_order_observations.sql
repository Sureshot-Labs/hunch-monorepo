-- Recovery metadata on the admitted action, not another economic ledger.
-- Existing submissions are eligible for bounded repair without a backfill.
alter table hip4_order_submissions
  add column reconcile_after timestamptz not null default '-infinity',
  add column reconcile_lease_token uuid,
  add column reconcile_lease_until timestamptz,
  add column reconcile_attempt_at timestamptz,
  add column reconcile_error text,
  add column order_observation jsonb,
  add column fills_observation jsonb;

create index hip4_order_submissions_due_idx
  on hip4_order_submissions(reconcile_after,action_id)
  where state<>'rejected' and debit_asset_id is not null;

create or replace function guard_hip4_order_submission_binding() returns trigger language plpgsql as $$
begin
  if (to_jsonb(new)-array['state','reply_summary','updated_at',
      'reconcile_after','reconcile_lease_token','reconcile_lease_until',
      'reconcile_attempt_at','reconcile_error','order_observation','fills_observation'])
    is distinct from (to_jsonb(old)-array['state','reply_summary','updated_at',
      'reconcile_after','reconcile_lease_token','reconcile_lease_until',
      'reconcile_attempt_at','reconcile_error','order_observation','fills_observation']) then
    raise exception 'HIP submission binding is immutable' using errcode='23514';
  end if;
  if old.state='rejected' and new.state<>'rejected' then
    raise exception 'Rejected HIP submission cannot be revived' using errcode='23514';
  end if;
  return new;
end
$$;
