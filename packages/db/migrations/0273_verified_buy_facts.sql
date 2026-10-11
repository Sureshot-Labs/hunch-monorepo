-- Facts are written only by server evidence verifiers, never trade recorders.
alter table order_fills add column provider_tx_hash text, add column provider_status text;
alter table copy_attributions
  add column execution_facts jsonb,
  add column repair_due_at timestamptz not null default now(),
  add column repair_lease_token uuid,
  add column repair_lease_until timestamptz;
alter table orders
  add column verified_buy_facts jsonb,
  add column verified_buy_state text not null default 'pending',
  add column verified_buy_reason text,
  add column verified_buy_revision bigint not null default 0,
  add column verified_buy_due_at timestamptz,
  add column verified_buy_lease_token uuid,
  add column verified_buy_lease_until timestamptz,
  add column verified_buy_attempts integer not null default 0;
alter table executions
  add column verified_buy_facts jsonb,
  add column verified_buy_state text not null default 'pending',
  add column verified_buy_reason text,
  add column verified_buy_revision bigint not null default 0,
  add column verified_buy_due_at timestamptz,
  add column verified_buy_lease_token uuid,
  add column verified_buy_lease_until timestamptz,
  add column verified_buy_attempts integer not null default 0;
-- NOT VALID checks permit legacy deployments without inspecting old rows.
alter table orders add constraint orders_verified_buy_state_valid
  check (verified_buy_state in ('pending', 'verified', 'revoked')) not valid;
alter table executions add constraint executions_verified_buy_state_valid
  check (verified_buy_state in ('pending', 'verified', 'revoked')) not valid;

-- Existing recorder updates schedule observations, not financial actions.
create function social_schedule_purchase_observation() returns trigger language plpgsql as $$
begin
  if upper(coalesce(new.side,''))='BUY' then
    new.verified_buy_due_at := now();
    new.verified_buy_lease_token := null;
    new.verified_buy_lease_until := null;
  end if;
  return new;
end;
$$;
create trigger orders_schedule_purchase_observation
  before insert or update of status,order_payload,filled_size,average_fill_price on orders
  for each row execute function social_schedule_purchase_observation();
create trigger executions_schedule_purchase_observation
  before insert or update of status,raw,amount_in,amount_out on executions
  for each row execute function social_schedule_purchase_observation();
