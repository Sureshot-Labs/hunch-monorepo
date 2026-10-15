-- A submission is a one-shot native action, not another economic order or a
-- synthetic funding operation. Existing unsigned preparations remain unchanged.
create table hip4_order_submissions (
  action_id uuid primary key references hip4_order_actions(id) on delete restrict,
  funding_trade_attempt_id uuid unique references funding_trade_attempts(id) on delete restrict,
  signature_fingerprint text not null check (signature_fingerprint ~ '^[a-f0-9]{64}$'),
  admission_snapshot jsonb not null check (jsonb_typeof(admission_snapshot)='object'),
  signer_address text not null check (signer_address ~ '^0x[0-9a-f]{40}$'),
  debit_asset_id text,
  debit_decimals smallint,
  debit_raw text,
  state text not null default 'submission_started'
    check (state in ('submission_started','reconcile_required','rejected')),
  reply_summary jsonb,
  started_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check ((debit_asset_id is null and debit_decimals is null and debit_raw is null)
    or (debit_asset_id is not null and debit_decimals between 0 and 36
      and debit_raw ~ '^[1-9][0-9]*$')),
  check (reply_summary is null or jsonb_typeof(reply_summary)='object')
);
create index hip4_order_submissions_reconcile_idx
  on hip4_order_submissions(updated_at,action_id) where state<>'rejected';
create index hip4_order_submissions_capacity_idx
  on hip4_order_submissions(signer_address,debit_asset_id,action_id) where state<>'rejected';
-- The action's existing signer/cloid and order/user indexes cover capacity and
-- lifecycle joins. No new index build over the existing orders table is needed.
create function guard_hip4_order_submission_binding() returns trigger language plpgsql as $$
begin
  if (to_jsonb(new)-array['state','reply_summary','updated_at'])
    is distinct from (to_jsonb(old)-array['state','reply_summary','updated_at']) then
    raise exception 'HIP submission binding is immutable' using errcode='23514';
  end if;
  if old.state='rejected' and new.state<>'rejected' then
    raise exception 'Rejected HIP submission cannot be revived' using errcode='23514';
  end if;
  return new;
end
$$;
create trigger hip4_order_submission_binding_guard before update on hip4_order_submissions
  for each row execute function guard_hip4_order_submission_binding();

alter table funding_trade_attempts drop constraint funding_trade_attempts_execution_path_check;
alter table funding_trade_attempts add constraint funding_trade_attempts_execution_path_check
  check (execution_path in ('polymarket_clob','limitless_clob','limitless_amm','kalshi_dflow','hyperliquid_outcome')) not valid;
