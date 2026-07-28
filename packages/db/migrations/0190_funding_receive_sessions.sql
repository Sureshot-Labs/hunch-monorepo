-- Durable amount-free receive intents.
--
-- A receive session tells a user which verified asset/network/address
-- combinations are safe to use. It does not reserve or guess an amount.
-- Every observed balance delta is recorded as an immutable receipt; any
-- conversion/routing work is linked through child_funding_operation_id.

create table funding_receive_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  status text not null default 'open'
    check (status in (
      'open',
      'processing',
      'review_required',
      'completed',
      'expired',
      'cancelled',
      'recovery_required'
    )),
  venue_id text not null,
  destination_option_id text not null,
  venue_binding_option_id text not null,
  destination_asset jsonb not null,
  destination_target_snapshot jsonb not null,
  venue_binding_snapshot jsonb not null,
  funding_methods jsonb not null,
  receive_targets jsonb not null,
  observation_variants jsonb not null,
  selected_receive_target_id text,
  automation_policy jsonb not null,
  policy_version bigint not null check (policy_version > 0),
  policy_revision text not null,
  ownership_revision text not null,
  version bigint not null default 1 check (version > 0),
  opened_at timestamptz not null default now(),
  last_observed_at timestamptz,
  expires_at timestamptz not null,
  observe_until timestamptz not null,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint funding_receive_sessions_destination_asset_check
    check (jsonb_typeof(destination_asset) = 'object'),
  constraint funding_receive_sessions_destination_target_check
    check (jsonb_typeof(destination_target_snapshot) = 'object'),
  constraint funding_receive_sessions_venue_binding_check
    check (jsonb_typeof(venue_binding_snapshot) = 'object'),
  constraint funding_receive_sessions_methods_check
    check (
      jsonb_typeof(funding_methods) = 'array'
      and jsonb_array_length(funding_methods) > 0
    ),
  constraint funding_receive_sessions_receive_targets_check
    check (
      jsonb_typeof(receive_targets) = 'array'
      and jsonb_array_length(receive_targets) > 0
    ),
  constraint funding_receive_sessions_observation_variants_check
    check (
      jsonb_typeof(observation_variants) = 'array'
      and jsonb_array_length(observation_variants) > 0
    ),
  constraint funding_receive_sessions_automation_policy_check
    check (
      jsonb_typeof(automation_policy) = 'object'
      and automation_policy ->> 'stableConversion' = 'automatic_within_caps'
      and automation_policy ->> 'volatileConversion' = 'review_required'
      and jsonb_typeof(automation_policy -> 'maximumFeeUsd') = 'string'
      and jsonb_typeof(automation_policy -> 'maximumFeeBps') = 'number'
      and jsonb_typeof(automation_policy -> 'maximumSlippageBps') = 'number'
    ),
  constraint funding_receive_sessions_revision_check
    check (
      length(trim(policy_revision)) between 8 and 192
      and length(trim(ownership_revision)) between 8 and 192
    ),
  constraint funding_receive_sessions_expiry_check
    check (expires_at > opened_at),
  constraint funding_receive_sessions_observation_grace_check
    check (observe_until > expires_at),
  constraint funding_receive_sessions_closed_check
    check (
      (status in ('open', 'processing', 'review_required', 'recovery_required') and closed_at is null)
      or (status in ('completed', 'expired', 'cancelled') and closed_at is not null)
    )
);

create index funding_receive_sessions_user_status_idx
  on funding_receive_sessions (user_id, status, created_at desc);

create index funding_receive_sessions_open_expiry_idx
  on funding_receive_sessions (expires_at, updated_at)
  where status in ('open', 'processing', 'review_required');

create index funding_receive_sessions_observation_grace_idx
  on funding_receive_sessions (observe_until, updated_at)
  where status in ('expired', 'cancelled');

create unique index funding_receive_sessions_one_open_destination_idx
  on funding_receive_sessions (
    user_id,
    destination_option_id,
    venue_binding_option_id
  )
  where status in ('open', 'processing', 'review_required');

create table funding_receive_receipts (
  id uuid primary key default gen_random_uuid(),
  receive_session_id uuid not null
    references funding_receive_sessions(id) on delete restrict,
  user_id uuid not null references users(id) on delete cascade,
  variant_id text not null,
  network_id text not null,
  asset_id text not null,
  asset_decimals integer not null
    check (asset_decimals between 0 and 36),
  destination_address text not null,
  raw_amount numeric(78, 0) not null check (raw_amount > 0),
  observation_revision text not null,
  tx_hash text,
  event_index text,
  ledger_height numeric(78, 0),
  block_hash text,
  source_address text,
  observed_at timestamptz not null,
  status text not null default 'observed'
    check (status in (
      'observed',
      'review_required',
      'routing',
      'ready',
      'recovery_required'
    )),
  handling text not null
    check (handling in ('direct', 'automatic_conversion', 'review_required')),
  child_funding_operation_id uuid
    references funding_operations(id) on delete restrict,
  review_quote_id uuid
    references funding_quotes(id) on delete restrict,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint funding_receive_receipts_evidence_check
    check (jsonb_typeof(evidence) = 'object'),
  constraint funding_receive_receipts_event_identity_check
    check (
      (
        tx_hash is null
        and event_index is null
        and ledger_height is null
        and block_hash is null
      )
      or (
        length(trim(tx_hash)) between 10 and 192
        and length(trim(event_index)) between 1 and 96
        and ledger_height is not null
        and ledger_height >= 0
        and length(trim(block_hash)) between 10 and 192
      )
    ),
  constraint funding_receive_receipts_observation_unique
    unique (receive_session_id, variant_id, observation_revision),
  constraint funding_receive_receipts_child_unique
    unique (child_funding_operation_id)
);

create index funding_receive_receipts_session_idx
  on funding_receive_receipts (receive_session_id, created_at);

create index funding_receive_receipts_user_status_idx
  on funding_receive_receipts (user_id, status, created_at desc);

create index funding_receive_receipts_review_quote_idx
  on funding_receive_receipts (review_quote_id)
  where review_quote_id is not null;

create unique index funding_receive_receipts_canonical_event_idx
  on funding_receive_receipts (network_id, tx_hash, event_index)
  where tx_hash is not null;

create or replace function guard_funding_receive_receipt_identity()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'funding receive receipts cannot be deleted';
  end if;
  if (
    new.receive_session_id,
    new.user_id,
    new.variant_id,
    new.network_id,
    new.asset_id,
    new.asset_decimals,
    new.destination_address,
    new.raw_amount,
    new.observation_revision,
    new.tx_hash,
    new.event_index,
    new.ledger_height,
    new.block_hash,
    new.source_address,
    new.observed_at,
    new.handling,
    new.created_at
  ) is distinct from (
    old.receive_session_id,
    old.user_id,
    old.variant_id,
    old.network_id,
    old.asset_id,
    old.asset_decimals,
    old.destination_address,
    old.raw_amount,
    old.observation_revision,
    old.tx_hash,
    old.event_index,
    old.ledger_height,
    old.block_hash,
    old.source_address,
    old.observed_at,
    old.handling,
    old.created_at
  ) then
    raise exception 'funding receive receipt identity is immutable';
  end if;
  if old.status = 'ready'
    and (
      new.status,
      new.child_funding_operation_id,
      new.evidence
    ) is distinct from (
      old.status,
      old.child_funding_operation_id,
      old.evidence
    ) then
    raise exception 'ready funding receive receipt is immutable';
  end if;
  return new;
end;
$$;

create trigger funding_receive_receipt_identity_guard
before update or delete on funding_receive_receipts
for each row execute function guard_funding_receive_receipt_identity();
