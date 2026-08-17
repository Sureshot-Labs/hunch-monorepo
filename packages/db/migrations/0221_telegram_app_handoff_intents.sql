-- A Mini App handoff seals one already-confirmed Telegram Buy plan.  It is
-- intentionally separate from funding execution: claiming this record cannot
-- submit a trade or create a funding operation on the server.

alter table telegram_trade_intents
  drop constraint if exists telegram_trade_intents_delivery_authority_check;

alter table telegram_trade_intents
  add constraint telegram_trade_intents_delivery_authority_check
  check (
    delivery_mode = 'bot_submit'
    or (
      action = 'buy'
      and status not in (
        'executing',
        'submitted',
        'filled',
        'reconcile_required'
      )
      and (
        status <> 'confirming'
        or (
          result ->> 'fundingState' = 'internal_route'
          and jsonb_typeof(result -> 'fundingProposal') = 'object'
        )
      )
      and (
        status <> 'funding'
        or funding_operation_id is not null
      )
      and submit_started_at is null
      and submitted_at is null
      and order_id is null
      and execution_id is null
      and venue_order_id is null
      and tx_signature is null
    )
  );

-- The individual columns are already each unique in user_telegram_accounts.
-- Keep the pair as an explicit referenced key so a handoff can never bind a
-- valid Telegram account to a different valid Hunch user.
alter table user_telegram_accounts
  add constraint user_telegram_accounts_user_telegram_unique
  unique (user_id, telegram_user_id);

create table if not exists telegram_app_handoffs (
  id uuid primary key default gen_random_uuid(),
  trade_intent_id uuid not null unique
    references telegram_trade_intents(id) on delete restrict,
  user_id uuid not null references users(id) on delete cascade,
  telegram_user_id text not null
    references user_telegram_accounts(telegram_user_id) on delete cascade,
  foreign key (user_id, telegram_user_id)
    references user_telegram_accounts(user_id, telegram_user_id)
    on delete cascade,
  token_hash text not null unique
    check (token_hash ~ '^[0-9a-f]{64}$'),
  state text not null default 'issued'
    check (state in ('issued', 'claimed', 'committed', 'cancelled', 'expired')),
  plan_fingerprint text not null
    check (plan_fingerprint ~ '^[0-9a-f]{64}$'),
  policy_revision text not null check (length(policy_revision) between 1 and 256),
  authority_fingerprint text not null
    check (authority_fingerprint ~ '^[0-9a-f]{64}$'),
  quote_snapshot jsonb not null check (jsonb_typeof(quote_snapshot) = 'object'),
  plan_snapshot jsonb not null check (jsonb_typeof(plan_snapshot) = 'object'),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  claimed_by_user_id uuid references users(id) on delete cascade,
  committed_at timestamptz,
  cancelled_at timestamptz,
  expired_at timestamptz,
  check (expires_at > issued_at),
  check ((claimed_at is null) = (claimed_by_user_id is null)),
  check (claimed_by_user_id is null or claimed_by_user_id = user_id),
  check (
    (state = 'issued'
      and claimed_at is null
      and committed_at is null
      and cancelled_at is null
      and expired_at is null)
    or (state = 'claimed'
      and claimed_at is not null
      and committed_at is null
      and cancelled_at is null
      and expired_at is null)
    or (state = 'committed'
      and claimed_at is not null
      and committed_at is not null
      and cancelled_at is null
      and expired_at is null)
    or (state = 'cancelled'
      and committed_at is null
      and cancelled_at is not null
      and expired_at is null)
    or (state = 'expired'
      and committed_at is null
      and cancelled_at is null
      and expired_at is not null)
  )
);

create index if not exists telegram_app_handoffs_user_state_expires_idx
  on telegram_app_handoffs(user_id, state, expires_at);

create or replace function guard_telegram_app_handoff_update()
returns trigger
language plpgsql
as $$
begin
  if new.id <> old.id
    or new.trade_intent_id <> old.trade_intent_id
    or new.user_id <> old.user_id
    or new.telegram_user_id <> old.telegram_user_id
    or new.token_hash <> old.token_hash
    or new.plan_fingerprint <> old.plan_fingerprint
    or new.policy_revision <> old.policy_revision
    or new.authority_fingerprint <> old.authority_fingerprint
    or new.quote_snapshot <> old.quote_snapshot
    or new.plan_snapshot <> old.plan_snapshot
    or new.issued_at <> old.issued_at
    or new.expires_at <> old.expires_at
  then
    raise exception 'telegram app handoff identity is immutable'
      using errcode = '23514';
  end if;

  if old.state = 'issued' and new.state = 'claimed'
    and new.claimed_at is not null
    and new.claimed_by_user_id = new.user_id
    and new.committed_at is null
    and new.cancelled_at is null
    and new.expired_at is null
  then
    return new;
  end if;
  if old.state = 'issued' and new.state = 'cancelled'
    and new.claimed_at is null
    and new.claimed_by_user_id is null
    and new.committed_at is null
    and new.cancelled_at is not null
    and new.expired_at is null
  then
    return new;
  end if;
  if old.state = 'issued' and new.state = 'expired'
    and new.claimed_at is null
    and new.claimed_by_user_id is null
    and new.committed_at is null
    and new.cancelled_at is null
    and new.expired_at is not null
  then
    return new;
  end if;
  if old.state = 'claimed' and new.state = 'committed'
    and new.claimed_at is not distinct from old.claimed_at
    and new.claimed_by_user_id is not distinct from old.claimed_by_user_id
    and new.committed_at is not null
    and new.cancelled_at is null
    and new.expired_at is null
  then
    return new;
  end if;
  if old.state = 'claimed' and new.state = 'cancelled'
    and new.claimed_at is not distinct from old.claimed_at
    and new.claimed_by_user_id is not distinct from old.claimed_by_user_id
    and new.committed_at is null
    and new.cancelled_at is not null
    and new.expired_at is null
  then
    return new;
  end if;
  if old.state = 'claimed' and new.state = 'expired'
    and new.claimed_at is not distinct from old.claimed_at
    and new.claimed_by_user_id is not distinct from old.claimed_by_user_id
    and new.committed_at is null
    and new.cancelled_at is null
    and new.expired_at is not null
  then
    return new;
  end if;
  if new.state = old.state
    and new.claimed_at is not distinct from old.claimed_at
    and new.claimed_by_user_id is not distinct from old.claimed_by_user_id
    and new.committed_at is not distinct from old.committed_at
    and new.cancelled_at is not distinct from old.cancelled_at
    and new.expired_at is not distinct from old.expired_at
  then
    return new;
  end if;

  raise exception 'illegal telegram app handoff state transition: % -> %', old.state, new.state
    using errcode = '23514';
end;
$$;

create trigger telegram_app_handoffs_guard
before update on telegram_app_handoffs
for each row execute function guard_telegram_app_handoff_update();
