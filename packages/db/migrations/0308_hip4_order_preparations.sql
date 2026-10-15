-- Native protocol metadata belongs to the existing economic orders, not to a
-- synthetic FundingOperation. This does not enable submission or any policy.
-- Widen existing checks without validating/rejecting speculative legacy rows.
alter table orders drop constraint if exists orders_venue_check;
alter table orders add constraint orders_venue_check
  check (venue in ('polymarket','kalshi','limitless','hyperliquid')) not valid;
alter table orders drop constraint if exists orders_order_type_check;
alter table orders add constraint orders_order_type_check
  check (order_type in ('GTC','GTD','FAK','FOK','IOC','ALO')) not valid;

create table hip4_order_actions (
  id uuid primary key,
  order_id uuid not null references orders(id) on delete restrict,
  request_key uuid not null unique,
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  action_kind text not null check (action_kind in ('order','cancelByCloid')),
  environment text not null check (environment in ('mainnet','testnet')),
  signer_address text not null check (signer_address ~ '^0x[0-9a-f]{40}$'),
  canonical_market_id text not null references unified_markets(id) on delete restrict,
  token_id text not null,
  cloid text not null check (cloid ~ '^0x[0-9a-f]{32}$'),
  nonce bigint not null check (nonce between 0 and 9007199254740991),
  action_fingerprint text not null check (action_fingerprint ~ '^[a-f0-9]{64}$'),
  unsigned_envelope jsonb not null check (jsonb_typeof(unsigned_envelope)='object'),
  preparation_snapshot jsonb not null check (jsonb_typeof(preparation_snapshot)='object'),
  -- Admission/submission is deliberately not implemented by this migration.
  state text not null default 'prepared' check (state in ('prepared','abandoned')),
  created_at timestamptz not null default clock_timestamp()
);
create index hip4_order_actions_order_idx on hip4_order_actions(order_id);
create index hip4_order_actions_market_idx on hip4_order_actions(canonical_market_id);
create unique index hip4_order_actions_initial_idx on hip4_order_actions(order_id) where action_kind='order';
create unique index hip4_order_actions_cloid_idx on hip4_order_actions(environment,signer_address,cloid) where action_kind='order';

-- Enforce future immutable authorization bindings, not assertions over history.
-- Ownership remains on orders so a controlled user merge can reparent it.
create function guard_hip4_order_action_binding() returns trigger language plpgsql as $$
begin
  if (to_jsonb(new)-'state') is distinct from (to_jsonb(old)-'state') then
    raise exception 'HIP order action binding is immutable' using errcode='23514';
  end if;
  if old.state='abandoned' and new.state<>'abandoned' then
    raise exception 'Abandoned HIP preparation cannot be revived' using errcode='23514';
  end if;
  return new;
end
$$;
create trigger hip4_order_action_binding_guard before update on hip4_order_actions
  for each row execute function guard_hip4_order_action_binding();

-- One signer/environment/nonce namespace for funding AND order/cancel actions.
-- Existing claims are unchanged; no nullable/fake funding consumer is created.
alter table hyperliquid_nonce_claims alter column funding_step_id drop not null;
alter table hyperliquid_nonce_claims add column order_action_id uuid unique
  references hip4_order_actions(id) on delete restrict;
alter table hyperliquid_nonce_claims add constraint hyperliquid_nonce_claim_owner_check
  check (num_nonnulls(funding_step_id,order_action_id)=1) not valid;
